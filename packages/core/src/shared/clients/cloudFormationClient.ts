/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    CloudFormationClient as Client,
    DeleteStackCommand,
    DescribeStackResourcesCommand,
    DescribeStackResourcesOutput,
    DescribeTypeCommand,
    DescribeTypeOutput,
    ListStacksCommand,
    ListStacksInput,
    ListStacksOutput,
    ListTypesCommand,
    ListTypesInput,
    ListTypesOutput,
    StackStatus,
    StackSummary,
    TypeSummary,
} from '@aws-sdk/client-cloudformation'
import globals from '../extensionGlobals'
import { AsyncCollection } from '../utilities/asyncCollection'
import { pageableToCollection } from '../utilities/collectionUtils'
import { ClassToInterfaceType, isNonNullable } from '../utilities/tsUtils'

export type CloudFormationClient = ClassToInterfaceType<DefaultCloudFormationClient>
export class DefaultCloudFormationClient {
    public constructor(public readonly regionCode: string) {}

    public async deleteStack(name: string): Promise<void> {
        const client = await this.createSdkClient()

        await client
            .send(new DeleteStackCommand({
                StackName: name,
            }))
    }

    public async describeType(typeName: string): Promise<DescribeTypeOutput> {
        const client = await this.createSdkClient()

        return await client
            .send(new DescribeTypeCommand({
                Type: 'RESOURCE',
                TypeName: typeName,
            }))
    }

    public async *listStacks(
        statusFilter: string[] = ['CREATE_COMPLETE', 'UPDATE_COMPLETE']
    ): AsyncIterableIterator<StackSummary> {
        const client = await this.createSdkClient()

        const request: ListStacksInput = {
            StackStatusFilter: statusFilter as StackStatus[],
        }

        do {
            const response: ListStacksOutput = await client.send(new ListStacksCommand(request))

            if (response.StackSummaries) {
                yield* response.StackSummaries
            }

            request.NextToken = response.NextToken
        } while (request.NextToken)
    }

    public listAllStacks(request: ListStacksInput = {}): AsyncCollection<StackSummary[]> {
        const client = this.createSdkClient()
        const requester = async (req: ListStacksInput) => (await client).send(new ListStacksCommand(req))
        const collection = pageableToCollection(requester, request, 'NextToken', 'StackSummaries')

        return collection.filter(isNonNullable)
    }

    public async *listTypes(): AsyncIterableIterator<TypeSummary> {
        const client = await this.createSdkClient()

        const request: ListTypesInput = {
            DeprecatedStatus: 'LIVE',
            Type: 'RESOURCE',
            Visibility: 'PUBLIC',
        }

        do {
            const response: ListTypesOutput = await client.send(new ListTypesCommand(request))

            if (response.TypeSummaries) {
                yield* response.TypeSummaries
            }

            request.NextToken = response.NextToken
        } while (request.NextToken)
    }

    public async describeStackResources(name: string): Promise<DescribeStackResourcesOutput> {
        const client = await this.createSdkClient()

        return await client
            .send(new DescribeStackResourcesCommand({
                StackName: name,
            }))
    }

    private async createSdkClient(): Promise<Client> {
        return await globals.sdkClientBuilderV3.createAwsService(Client, undefined, this.regionCode)
    }
}
