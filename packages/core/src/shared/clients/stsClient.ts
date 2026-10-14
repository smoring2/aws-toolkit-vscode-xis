/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    AssumeRoleCommand,
    AssumeRoleRequest,
    AssumeRoleResponse,
    GetCallerIdentityCommand,
    GetCallerIdentityResponse,
    STSClient,
} from '@aws-sdk/client-sts'
import { Credentials } from '@aws-sdk/types'
import globals from '../extensionGlobals'
import { ClassToInterfaceType } from '../utilities/tsUtils'

export type StsClient = ClassToInterfaceType<DefaultStsClient>
export class DefaultStsClient {
    public constructor(
        public readonly regionCode: string,
        private readonly credentials?: Credentials
    ) {}

    public async assumeRole(request: AssumeRoleRequest): Promise<AssumeRoleResponse> {
        const sdkClient = await this.createSdkClient()
        const response = await sdkClient.send(new AssumeRoleCommand(request))
        return response
    }

    public async getCallerIdentity(): Promise<GetCallerIdentityResponse> {
        const sdkClient = await this.createSdkClient()
        const response = await sdkClient.send(new GetCallerIdentityCommand({}))
        return response
    }

    private async createSdkClient(): Promise<STSClient> {
        // Regional STS endpoints are the default in the AWS SDK v3, so no explicit
        // `stsRegionalEndpoints` configuration is needed.
        return await globals.sdkClientBuilderV3.createAwsService(
            STSClient,
            {
                credentials: this.credentials,
            },
            this.regionCode
        )
    }
}
