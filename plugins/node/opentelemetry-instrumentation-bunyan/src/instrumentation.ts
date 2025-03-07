/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { inherits } from 'util';
import { context, trace, isSpanContextValid, Span } from '@opentelemetry/api';
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  safeExecuteInTheMiddle,
} from '@opentelemetry/instrumentation';
import { BunyanInstrumentationConfig } from './types';
/** @knipignore */
import { PACKAGE_NAME, PACKAGE_VERSION } from './version';
import { OpenTelemetryBunyanStream } from './OpenTelemetryBunyanStream';
import type * as BunyanLogger from 'bunyan';
import { SeverityNumber } from '@opentelemetry/api-logs';

const DEFAULT_CONFIG: BunyanInstrumentationConfig = {
  disableLogSending: false,
  disableLogCorrelation: false,
};

export class BunyanInstrumentation extends InstrumentationBase<BunyanInstrumentationConfig> {
  constructor(config: BunyanInstrumentationConfig = {}) {
    super(PACKAGE_NAME, PACKAGE_VERSION, { ...DEFAULT_CONFIG, ...config });
  }

  protected init() {
    return [
      new InstrumentationNodeModuleDefinition(
        'bunyan',
        ['>=1.0.0 <2'],
        (module: any) => {
          const instrumentation = this;
          const Logger =
            module[Symbol.toStringTag] === 'Module'
              ? module.default // ESM
              : module; // CommonJS

          this._wrap(
            Logger.prototype,
            '_emit',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this._getPatchedEmit() as any
          );

          function LoggerTraced(this: any, ...args: unknown[]) {
            let inst;
            let retval = undefined;
            if (this instanceof LoggerTraced) {
              // called with `new Logger()`
              inst = this;
              Logger.apply(this, args);
            } else {
              // called without `new`
              inst = Logger(...args);
              retval = inst;
            }
            // If `_childOptions` is defined, this is a `Logger#child(...)`
            // call. We must not add an OTel stream again.
            if (args[1] /* _childOptions */ === undefined) {
              instrumentation._addStream(inst);
            }
            return retval;
          }
          // Must use the deprecated `inherits` to support this style:
          //    const log = require('bunyan')({name: 'foo'});
          // i.e. calling the constructor function without `new`.
          inherits(LoggerTraced, Logger);

          const patchedExports = Object.assign(LoggerTraced, Logger);

          this._wrap(
            patchedExports,
            'createLogger',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this._getPatchedCreateLogger() as any
          );

          return patchedExports;
        }
      ),
    ];
  }

  override setConfig(config: BunyanInstrumentationConfig = {}) {
    super.setConfig({ ...DEFAULT_CONFIG, ...config });
  }

  private _getPatchedEmit() {
    return (original: (...args: unknown[]) => void) => {
      const instrumentation = this;
      return function patchedEmit(this: BunyanLogger, ...args: unknown[]) {
        const config = instrumentation.getConfig();
        if (!instrumentation.isEnabled() || config.disableLogCorrelation) {
          return original.apply(this, args);
        }

        const span = trace.getSpan(context.active());
        if (!span) {
          return original.apply(this, args);
        }

        const spanContext = span.spanContext();
        if (!isSpanContextValid(spanContext)) {
          return original.apply(this, args);
        }

        const record = args[0] as Record<string, string>;
        record['trace_id'] = spanContext.traceId;
        record['span_id'] = spanContext.spanId;
        record['trace_flags'] = `0${spanContext.traceFlags.toString(16)}`;

        instrumentation._callHook(span, record);

        return original.apply(this, args);
      };
    };
  }

  private _getPatchedCreateLogger() {
    return (original: (...args: unknown[]) => void) => {
      const instrumentation = this;
      return function patchedCreateLogger(...args: unknown[]) {
        const logger = original(...args);
        instrumentation._addStream(logger);
        return logger;
      };
    };
  }

  private _addStream(logger: any) {
    const config = this.getConfig();
    if (!this.isEnabled() || config.disableLogSending) {
      return;
    }
    this._diag.debug('Adding OpenTelemetryBunyanStream to logger');
    let streamLevel = logger.level();
    if (config.logSeverity) {
      const bunyanLevel = bunyanLevelFromSeverity(config.logSeverity);
      streamLevel = bunyanLevel || streamLevel;
    }
    logger.addStream({
      type: 'raw',
      stream: new OpenTelemetryBunyanStream(),
      level: streamLevel,
    });
  }

  private _callHook(span: Span, record: Record<string, string>) {
    const { logHook } = this.getConfig();

    if (typeof logHook !== 'function') {
      return;
    }

    safeExecuteInTheMiddle(
      () => logHook(span, record),
      err => {
        if (err) {
          this._diag.error('error calling logHook', err);
        }
      },
      true
    );
  }
}

function bunyanLevelFromSeverity(severity: SeverityNumber): string | undefined {
  if (severity >= SeverityNumber.FATAL) {
    return 'fatal';
  } else if (severity >= SeverityNumber.ERROR) {
    return 'error';
  } else if (severity >= SeverityNumber.WARN) {
    return 'warn';
  } else if (severity >= SeverityNumber.INFO) {
    return 'info';
  } else if (severity >= SeverityNumber.DEBUG) {
    return 'debug';
  } else if (severity >= SeverityNumber.TRACE) {
    return 'trace';
  }
  return;
}
