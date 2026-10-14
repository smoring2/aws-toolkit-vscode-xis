/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    DescribeIamInstanceProfileAssociationsCommand,
    DescribeIamInstanceProfileAssociationsRequest,
    DescribeInstanceStatusCommand,
    DescribeInstanceStatusRequest,
    DescribeInstancesCommand,
    DescribeInstancesRequest,
    EC2Client,
    Filter,
    GetConsoleOutputCommand,
    GetConsoleOutputRequest,
    IamInstanceProfile,
    IamInstanceProfileAssociation,
    Instance,
    InstanceStateName,
    RebootInstancesCommand,
    Reservation,
    StartInstancesCommand,
    StartInstancesResult,
    StopInstancesCommand,
    StopInstancesResult,
} from '@aws-sdk/client-ec2'
import { AsyncCollection } from '../utilities/asyncCollection'
import { pageableToCollection } from '../utilities/collectionUtils'
import globals from '../extensionGlobals'
import { Timeout } from '../utilities/timeoutUtils'
import { showMessageWithCancel } from '../utilities/messages'
import { ToolkitError, isAwsError } from '../errors'
import { decodeBase64 } from '../utilities/textUtilities'

/**
 * An EC2 instance state name.
 *
 * The AWS SDK v2 typings widened their enums with `string`, so this preserves the previous
 * behavior for callers which pass arbitrary status strings.
 */
export type Ec2InstanceStatus = InstanceStateName | string

/**
 * A wrapper around Instance where we can safely assume InstanceId field exists.
 */
export interface SafeEc2Instance extends Instance {
    InstanceId: string
    Name?: string
    LastSeenStatus: Ec2InstanceStatus
}

interface SafeEc2GetConsoleOutputResult extends GetConsoleOutputRequest {
    Output: string
    InstanceId: string
}

export class Ec2Client {
    public constructor(public readonly regionCode: string) {}

    private async createSdkClient(): Promise<EC2Client> {
        return await globals.sdkClientBuilderV3.createAwsService(EC2Client, undefined, this.regionCode)
    }

    public async getInstances(filters?: Filter[]): Promise<AsyncCollection<SafeEc2Instance>> {
        const client = await this.createSdkClient()

        const requester = async (request: DescribeInstancesRequest) =>
            client.send(new DescribeInstancesCommand(request))
        const collection = pageableToCollection(
            requester,
            filters ? { Filters: filters } : {},
            'NextToken',
            'Reservations'
        )
        const extractedInstances = this.getInstancesFromReservations(collection)
        const instances = await this.updateInstancesDetail(extractedInstances)

        return instances
    }

    /** Updates status and name in-place for displaying to humans. */
    protected async updateInstancesDetail(
        instances: AsyncCollection<Instance>
    ): Promise<AsyncCollection<SafeEc2Instance>> {
        // Intermediate interface so that I can coerce Instance to SafeEc2Instnace
        interface SafeEc2InstanceWithoutStatus extends Instance {
            InstanceId: string
            Name?: string
        }

        const safeInstances: AsyncCollection<SafeEc2InstanceWithoutStatus> = instances.filter(
            (instance) => instance.InstanceId !== undefined
        )

        return safeInstances
            .map(async (instance) => {
                return { ...instance, LastSeenStatus: await this.getInstanceStatus(instance.InstanceId) }
            })
            .map((instance) => {
                return instanceHasName(instance!)
                    ? { ...instance, Name: lookupTagKey(instance!.Tags!, 'Name') }
                    : instance!
            })
    }

    public getInstancesFromReservations(
        reservations: AsyncCollection<Reservation[] | undefined>
    ): AsyncCollection<Instance> {
        return reservations
            .flatten()
            .map((instanceList) => instanceList?.Instances)
            .flatten()
            .filter((instance) => instance!.InstanceId !== undefined)
    }

    public async getInstanceStatus(instanceId: string): Promise<Ec2InstanceStatus> {
        const client = await this.createSdkClient()
        const requester = async (request: DescribeInstanceStatusRequest) =>
            client.send(new DescribeInstanceStatusCommand(request))

        const response = await pageableToCollection(
            requester,
            { InstanceIds: [instanceId], IncludeAllInstances: true },
            'NextToken',
            'InstanceStatuses'
        )
            .flatten()
            .map((instanceStatus) => instanceStatus!.InstanceState!.Name!)
            .promise()

        return response[0]
    }

    public async isInstanceRunning(instanceId: string): Promise<boolean> {
        const status = await this.getInstanceStatus(instanceId)
        return status === 'running'
    }

    public getInstancesFilter(instanceIds: string[]): Filter[] {
        return [
            {
                Name: 'instance-id',
                Values: instanceIds,
            },
        ]
    }

    private handleStatusError(instanceId: string, err: unknown) {
        if (isAwsError(err)) {
            throw new ToolkitError(`EC2: failed to change status of instance ${instanceId}`, {
                cause: err as Error,
            })
        } else {
            throw err
        }
    }

    public async ensureInstanceNotInStatus(instanceId: string, targetStatus: string) {
        const isAlreadyInStatus = (await this.getInstanceStatus(instanceId)) === targetStatus
        if (isAlreadyInStatus) {
            throw new ToolkitError(
                `EC2: Instance is currently ${targetStatus}. Unable to update status of ${instanceId}.`
            )
        }
    }

    public async startInstance(instanceId: string): Promise<StartInstancesResult> {
        const client = await this.createSdkClient()

        const response = await client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }))

        return response
    }

    public async startInstanceWithCancel(instanceId: string): Promise<void> {
        const timeout = new Timeout(5000)

        await showMessageWithCancel(`EC2: Starting instance ${instanceId}`, timeout)

        try {
            await this.ensureInstanceNotInStatus(instanceId, 'running')
            await this.startInstance(instanceId)
        } catch (err) {
            this.handleStatusError(instanceId, err)
        } finally {
            timeout.cancel()
        }
    }

    public async stopInstance(instanceId: string): Promise<StopInstancesResult> {
        const client = await this.createSdkClient()

        const response = await client.send(new StopInstancesCommand({ InstanceIds: [instanceId] }))

        return response
    }

    public async stopInstanceWithCancel(instanceId: string): Promise<void> {
        const timeout = new Timeout(5000)

        await showMessageWithCancel(`EC2: Stopping instance ${instanceId}`, timeout)

        try {
            await this.ensureInstanceNotInStatus(instanceId, 'stopped')
            await this.stopInstance(instanceId)
        } catch (err) {
            this.handleStatusError(instanceId, err)
        } finally {
            timeout.cancel()
        }
    }

    public async rebootInstance(instanceId: string): Promise<void> {
        const client = await this.createSdkClient()

        await client.send(new RebootInstancesCommand({ InstanceIds: [instanceId] }))
    }

    public async rebootInstanceWithCancel(instanceId: string): Promise<void> {
        const timeout = new Timeout(5000)

        await showMessageWithCancel(`EC2: Rebooting instance ${instanceId}`, timeout)

        try {
            await this.rebootInstance(instanceId)
        } catch (err) {
            this.handleStatusError(instanceId, err)
        } finally {
            timeout.cancel()
        }
    }

    /**
     * Retrieve IAM Association for a given EC2 instance.
     * @param instanceId target EC2 instance ID
     * @returns IAM Association for instance
     */
    private async getIamInstanceProfileAssociation(instanceId: string): Promise<IamInstanceProfileAssociation> {
        const client = await this.createSdkClient()
        const instanceFilter = this.getInstancesFilter([instanceId])
        const requester = async (request: DescribeIamInstanceProfileAssociationsRequest) =>
            client.send(new DescribeIamInstanceProfileAssociationsCommand(request))
        const response = await pageableToCollection(
            requester,
            { Filters: instanceFilter },
            'NextToken',
            'IamInstanceProfileAssociations'
        )
            .flatten()
            .filter((association) => association !== undefined)
            .promise()

        return response[0]!
    }

    /**
     * Gets the IAM Instance Profile (not role) attached to given EC2 instance.
     * @param instanceId target EC2 instance ID
     * @returns IAM Instance Profile associated with instance or undefined if none exists.
     */
    public async getAttachedIamInstanceProfile(instanceId: string): Promise<IamInstanceProfile | undefined> {
        const association = await this.getIamInstanceProfileAssociation(instanceId)
        return association ? association.IamInstanceProfile : undefined
    }

    public async getConsoleOutput(instanceId: string, latest: boolean): Promise<SafeEc2GetConsoleOutputResult> {
        const client = await this.createSdkClient()
        const response = await client.send(new GetConsoleOutputCommand({ InstanceId: instanceId, Latest: latest }))
        return {
            ...response,
            InstanceId: instanceId,
            Output: response.Output ? decodeBase64(response.Output) : '',
        }
    }
}

export function getNameOfInstance(instance: Instance): string | undefined {
    return instanceHasName(instance) ? lookupTagKey(instance.Tags!, 'Name')! : undefined
}

export function instanceHasName(instance: Instance): boolean {
    return instance.Tags !== undefined && instance.Tags.some((tag) => tag.Key === 'Name')
}

function lookupTagKey(tags: { Key?: string; Value?: string }[], targetKey: string) {
    return tags.filter((tag) => tag.Key === targetKey)[0].Value
}
