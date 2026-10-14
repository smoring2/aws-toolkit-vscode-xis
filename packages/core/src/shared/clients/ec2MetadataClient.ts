/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as http from 'http' // eslint-disable-line no-restricted-imports
import { getLogger } from '../logger'
import { ClassToInterfaceType } from '../utilities/tsUtils'

export interface IamInfo {
    Code: string
    LastUpdated: string
    InstanceProfileArn: string
    InstanceProfileId: string
}

export interface InstanceIdentity {
    region: string
}

const metadataServiceHost = '169.254.169.254'
const tokenPath = '/latest/api/token'
const tokenTtlSeconds = '21600'

export type Ec2MetadataClient = ClassToInterfaceType<DefaultEc2MetadataClient>
export class DefaultEc2MetadataClient {
    private static readonly metadataServiceTimeout: number = 500

    public getInstanceIdentity(): Promise<InstanceIdentity> {
        return this.invoke<InstanceIdentity>('/latest/dynamic/instance-identity/document')
    }

    public getIamInfo(): Promise<IamInfo> {
        return this.invoke<IamInfo>('/latest/meta-data/iam/info')
    }

    public async invoke<T>(path: string): Promise<T> {
        let headers: http.OutgoingHttpHeaders = {}

        try {
            const token = await this.fetchMetadataToken()
            headers = {
                // By attaching the token we force the use of IMDSv2.
                // https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-metadata-v2-how-it-works.html
                'x-aws-ec2-metadata-token': token,
            }
        } catch (tokenErr) {
            getLogger().warn(
                'Ec2MetadataClient failed to fetch token. If this is an EC2 environment, then Toolkit will fall back to IMDSv1: %s',
                tokenErr
            )
            // Fall back to IMDSv1 for legacy instances.
        }

        const response = await this.request('GET', path, headers)

        try {
            return JSON.parse(response) as T
        } catch (e) {
            throw new Error(`Ec2MetadataClient: invalid response from "${path}": ${response}\nerror: ${e}`)
        }
    }

    private fetchMetadataToken(): Promise<string> {
        return this.request('PUT', tokenPath, { 'x-aws-ec2-metadata-token-ttl-seconds': tokenTtlSeconds })
    }

    private request(method: string, path: string, headers: http.OutgoingHttpHeaders): Promise<string> {
        const timeout = DefaultEc2MetadataClient.metadataServiceTimeout

        return new Promise<string>((resolve, reject) => {
            const req = http.request({ host: metadataServiceHost, method, path, headers, timeout }, (res) => {
                let data = ''
                res.on('data', (chunk) => (data += chunk))
                res.on('end', () => {
                    if (res.statusCode !== undefined && (res.statusCode < 200 || res.statusCode >= 300)) {
                        reject(new Error(`Ec2MetadataClient: "${path}" failed with status ${res.statusCode}`))
                    } else {
                        resolve(data)
                    }
                })
            })

            req.on('timeout', () => req.destroy(new Error(`Ec2MetadataClient: "${path}" timed out`)))
            req.on('error', reject)
            req.end()
        })
    }
}
