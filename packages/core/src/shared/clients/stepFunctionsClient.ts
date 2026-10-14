/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    CreateStateMachineCommand,
    CreateStateMachineInput,
    CreateStateMachineOutput,
    DescribeStateMachineCommand,
    DescribeStateMachineInput,
    DescribeStateMachineOutput,
    ListStateMachinesCommand,
    ListStateMachinesInput,
    ListStateMachinesOutput,
    SFNClient as Client,
    StartExecutionCommand,
    StartExecutionInput,
    StartExecutionOutput,
    StateMachineListItem,
    UpdateStateMachineCommand,
    UpdateStateMachineInput,
    UpdateStateMachineOutput,
} from '@aws-sdk/client-sfn'
import globals from '../extensionGlobals'
import { ClassToInterfaceType } from '../utilities/tsUtils'

export type StepFunctionsClient = ClassToInterfaceType<DefaultStepFunctionsClient>
export class DefaultStepFunctionsClient {
    public constructor(public readonly regionCode: string) {}

    public async *listStateMachines(): AsyncIterableIterator<StateMachineListItem> {
        const client = await this.createSdkClient()

        const request: ListStateMachinesInput = {}
        do {
            const response: ListStateMachinesOutput = await client.send(new ListStateMachinesCommand(request))

            if (response.stateMachines) {
                yield* response.stateMachines
            }

            request.nextToken = response.nextToken
        } while (request.nextToken)
    }

    public async getStateMachineDetails(arn: string): Promise<DescribeStateMachineOutput> {
        const client = await this.createSdkClient()

        const request: DescribeStateMachineInput = {
            stateMachineArn: arn,
        }

        const response: DescribeStateMachineOutput = await client.send(new DescribeStateMachineCommand(request))

        return response
    }

    public async executeStateMachine(arn: string, input?: string): Promise<StartExecutionOutput> {
        const client = await this.createSdkClient()

        const request: StartExecutionInput = {
            stateMachineArn: arn,
            input: input,
        }

        const response: StartExecutionOutput = await client.send(new StartExecutionCommand(request))

        return response
    }

    public async createStateMachine(params: CreateStateMachineInput): Promise<CreateStateMachineOutput> {
        const client = await this.createSdkClient()

        return client.send(new CreateStateMachineCommand(params))
    }

    public async updateStateMachine(params: UpdateStateMachineInput): Promise<UpdateStateMachineOutput> {
        const client = await this.createSdkClient()

        return client.send(new UpdateStateMachineCommand(params))
    }

    private async createSdkClient(): Promise<Client> {
        return await globals.sdkClientBuilderV3.createAwsService(Client, undefined, this.regionCode)
    }
}
