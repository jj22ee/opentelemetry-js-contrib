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

import { Attributes, Context, Link, SpanKind } from '@opentelemetry/api';
import {
  Sampler,
  SamplingDecision,
  SamplingResult,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { RateLimitingSampler } from './rate-limiting-sampler';

// FallbackSampler samples 1 req/sec and additional 5% of requests using TraceIdRatioBasedSampler.
export class FallbackSampler implements Sampler {
  private fixedRateSampler: TraceIdRatioBasedSampler;
  private rateLimitingSampler: RateLimitingSampler;

  constructor() {
    this.fixedRateSampler = new TraceIdRatioBasedSampler(0.05);
    this.rateLimitingSampler = new RateLimitingSampler(1);
  }

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[]
  ): SamplingResult {
    const samplingResult: SamplingResult =
      this.rateLimitingSampler.shouldSample(
        context,
        traceId,
        spanName,
        spanKind,
        attributes,
        links
      );

    if (samplingResult.decision !== SamplingDecision.NOT_RECORD) {
      return samplingResult;
    }

    return this.fixedRateSampler.shouldSample(context, traceId);
  }

  public toString(): string {
    return 'FallbackSampler{fallback sampling with sampling config of 1 req/sec and 5% of additional requests';
  }
}
