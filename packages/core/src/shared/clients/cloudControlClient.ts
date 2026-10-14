/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    CloudControlClient as Client,
    CreateResourceCommand,
    CreateResourceInput,
    CreateResourceOutput,
    DeleteResourceCommand,
    DeleteResourceInput,
    GetResourceCommand,
    GetResourceInput,
    GetResourceOutput,
    GetResourceRequestStatusCommand,
    ListResourcesCommand,
    ListResourcesInput,
    ListResourcesOutput,
    ProgressEvent,
    UpdateResourceCommand,
    UpdateResourceInput,
} from '@aws-sdk/client-cloudcontrol'
import globals from '../extensionGlobals'
import { ClassToInterfaceType } from '../utilities/tsUtils'
import { localize } from '../utilities/vsCodeUtils'

export type CloudControlClient = ClassToInterfaceType<DefaultCloudControlClient>
export class DefaultCloudControlClient implements CloudControlClient {
    public constructor(public readonly regionCode: string) {}

    public async createResource(request: CreateResourceInput): Promise<CreateResourceOutput> {
        const client = await this.createSdkClient()

        const createResponse = await client.send(new CreateResourceCommand(request))

        await this.pollForCompletion(client, createResponse.ProgressEvent!)
        return createResponse
    }

    public async deleteResource(request: DeleteResourceInput): Promise<void> {
        const client = await this.createSdkClient()

        const deleteResponse = await client.send(new DeleteResourceCommand(request))

        await this.pollForCompletion(client, deleteResponse.ProgressEvent!)
    }

    public async listResources(request: ListResourcesInput): Promise<ListResourcesOutput> {
        const client = await this.createSdkClient()

        return await client.send(new ListResourcesCommand(request))
    }

    public async getResource(request: GetResourceInput): Promise<GetResourceOutput> {
        const client = await this.createSdkClient()

        return await client.send(new GetResourceCommand(request))
    }

    public async updateResource(request: UpdateResourceInput): Promise<void> {
        const client = await this.createSdkClient()

        const updateResponse = await client.send(new UpdateResourceCommand(request))

        await this.pollForCompletion(client, updateResponse.ProgressEvent!)
    }

    private async pollForCompletion(
        client: Client,
        progressEvent: ProgressEvent,
        baseDelay: number = 500,
        maxRetries: number = 10
    ): Promise<void> {
        for (let i = 0; i < maxRetries; i++) {
            const operationStatus = progressEvent.OperationStatus

            switch (operationStatus) {
                case 'SUCCESS':
                    return
                case 'FAILED':
                    throw new Error(
                        localize(
                            'AWS.message.error.cloudControl.pollResourceStatus.failed',
                            'Resource operation failed: {0} ({1})',
                            progressEvent.StatusMessage,
                            progressEvent.ErrorCode
                        )
                    )
                case 'CANCEL_COMPLETE':
                    throw new Error(
                        localize(
                            'AWS.message.error.cloudControl.pollResourceStatus.cancelled',
                            'Resource operation cancelled: {0}',
                            progressEvent.StatusMessage
                        )
                    )
                case 'IN_PROGRESS':
                case 'CANCEL_IN_PROGRESS':
                case 'PENDING':
                    break
                default:
                    throw new Error(
                        localize(
                            'AWS.message.error.cloudControl.pollResourceStatus.invalidOperationStatus',
                            'Invalid resource operation status: {0}',
                            operationStatus
                        )
                    )
            }

            if (i + 1 < maxRetries) {
                await new Promise<void>((resolve) => globals.clock.setTimeout(resolve, baseDelay * 2 ** i))
                const resourceRequestStatus = await client.send(
                    new GetResourceRequestStatusCommand({
                        RequestToken: progressEvent.RequestToken!,
                    })
                )
                progressEvent = resourceRequestStatus.ProgressEvent!
            }
        }
        throw new Error(
            localize(
                'AWS.message.error.cloudControl.pollResourceStatus.timeout',
                'Failed to get terminal resource operation status for {0} before timeout. Please try again later',
                progressEvent.Identifier
            )
        )
    }

    private async createSdkClient(): Promise<Client> {
        return await globals.sdkClientBuilderV3.createAwsService(Client, undefined, this.regionCode)
    }
}
