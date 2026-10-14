/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Runtime as LambdaSdkRuntime } from '@aws-sdk/client-lambda'

/**
 * A Lambda runtime identifier.
 *
 * The AWS SDK v3 `Runtime` type only enumerates the runtimes known to the bundled service
 * model, while the Toolkit also handles runtimes that are newer (or SAM-only). The AWS SDK v2
 * typings widened their enums with `string`, so this preserves the previous behavior.
 */
export type Runtime = LambdaSdkRuntime | string
