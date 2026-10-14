/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    AttachRolePolicyCommand,
    AttachRolePolicyRequest,
    AttachedPolicy,
    CreateRoleCommand,
    CreateRoleRequest,
    CreateRoleResponse,
    EvaluationResult,
    GetInstanceProfileCommand,
    IAMClient as Client,
    ListAttachedRolePoliciesCommand,
    ListAttachedRolePoliciesRequest,
    ListRolesCommand,
    ListRolesRequest,
    PutRolePolicyCommand,
    Role,
    SimulatePolicyResponse,
    SimulatePrincipalPolicyCommand,
    SimulatePrincipalPolicyRequest,
} from '@aws-sdk/client-iam'
import globals from '../extensionGlobals'
import { AsyncCollection } from '../utilities/asyncCollection'
import { pageableToCollection } from '../utilities/collectionUtils'
import { ClassToInterfaceType } from '../utilities/tsUtils'
import { ToolkitError } from '../errors'

export type IamClient = ClassToInterfaceType<DefaultIamClient>

/** Do not pull more than this many pages. */
const maxPages = 500

export class DefaultIamClient {
    public constructor(public readonly regionCode: string) {}

    public getRoles(request: ListRolesRequest = {}): AsyncCollection<Role[]> {
        const requester = async (request: ListRolesRequest) =>
            (await this.createSdkClient()).send(new ListRolesCommand(request))
        const collection = pageableToCollection(requester, request, 'Marker', 'Roles')

        return collection.map((roles) => roles ?? []).limit(maxPages)
    }

    /** Gets all roles. */
    public async listRoles(request: ListRolesRequest = {}): Promise<Role[]> {
        return this.getRoles(request).flatten().promise()
    }

    public async createRole(request: CreateRoleRequest): Promise<CreateRoleResponse> {
        const sdkClient = await this.createSdkClient()
        const response = await sdkClient.send(new CreateRoleCommand(request))

        return response
    }

    public async attachRolePolicy(request: AttachRolePolicyRequest): Promise<void> {
        const sdkClient = await this.createSdkClient()
        await sdkClient.send(new AttachRolePolicyCommand(request))
    }

    public async simulatePrincipalPolicy(request: SimulatePrincipalPolicyRequest): Promise<SimulatePolicyResponse> {
        const sdkClient = await this.createSdkClient()
        return await sdkClient.send(new SimulatePrincipalPolicyCommand(request))
    }

    /**
     * Attempts to verify if a role has the provided permissions.
     */
    public async getDeniedActions(request: SimulatePrincipalPolicyRequest): Promise<EvaluationResult[]> {
        const permissionResponse = await this.simulatePrincipalPolicy(request)
        if (!permissionResponse.EvaluationResults) {
            throw new Error('No evaluation results found')
        }

        // Ignore deny from Organization SCP.  These can result in false negatives.
        // See https://github.com/aws/aws-sdk/issues/102
        return permissionResponse.EvaluationResults.filter(
            (r) => r.EvalDecision !== 'allowed' && r.OrganizationsDecisionDetail?.AllowedByOrganizations !== false
        )
    }

    private async createSdkClient(): Promise<Client> {
        return await globals.sdkClientBuilderV3.createAwsService(Client, undefined, this.regionCode)
    }

    public getFriendlyName(arn: string): string {
        const tokens = arn.split('/')
        if (tokens.length < 2) {
            throw new Error(`Invalid IAM role ARN (expected format: arn:aws:iam::{id}/{name}): ${arn}`)
        }
        return tokens[tokens.length - 1]
    }

    public async listAttachedRolePolicies(arn: string): Promise<AttachedPolicy[]> {
        const client = await this.createSdkClient()
        const roleName = this.getFriendlyName(arn)

        const requester = async (request: ListAttachedRolePoliciesRequest) =>
            client.send(new ListAttachedRolePoliciesCommand(request))

        const collection = pageableToCollection(requester, { RoleName: roleName }, 'Marker', 'AttachedPolicies')
            .flatten()
            .filter((p) => p !== undefined)
            .map((p) => p!)

        const policies = await collection.promise()

        return policies
    }

    public async getIAMRoleFromInstanceProfile(instanceProfileArn: string): Promise<Role> {
        const client = await this.createSdkClient()
        const instanceProfileName = this.getFriendlyName(instanceProfileArn)
        const response = await client.send(new GetInstanceProfileCommand({ InstanceProfileName: instanceProfileName }))
        const roles = response.InstanceProfile?.Roles
        if (!roles || roles.length === 0) {
            throw new ToolkitError(`Failed to find IAM role associated with Instance profile ${instanceProfileArn}`)
        }
        return roles[0]
    }

    public async putRolePolicy(roleArn: string, policyName: string, policyDocument: string): Promise<void> {
        const client = await this.createSdkClient()
        const roleName = this.getFriendlyName(roleArn)
        await client.send(
            new PutRolePolicyCommand({ RoleName: roleName, PolicyName: policyName, PolicyDocument: policyDocument })
        )
    }
}
