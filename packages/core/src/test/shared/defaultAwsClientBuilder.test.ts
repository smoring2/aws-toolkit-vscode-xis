/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import { S3Client } from '@aws-sdk/client-s3'
import { version } from 'vscode'
import { AWSClientBuilderV3, Middleware } from '../../shared/awsClientBuilder'
import { DevSettings } from '../../shared/settings'
import { getClientId } from '../../shared/telemetry/util'
import { FakeMemento } from '../fakeExtensionContext'
import { FakeAwsContext } from '../utilities/fakeAwsContext'
import { TestSettings } from '../utilities/testSettingsConfiguration'
import { GlobalState } from '../../shared/globalState'

describe('AWSClientBuilderV3', function () {
    let builder: AWSClientBuilderV3

    beforeEach(function () {
        builder = new AWSClientBuilderV3(new FakeAwsContext())
    })

    describe('createAwsService', function () {
        it('includes Toolkit user-agent if no options are specified', async function () {
            const service = await builder.createAwsService(S3Client)
            const clientId = getClientId(new GlobalState(new FakeMemento()))

            assert.strictEqual(!!service.config.customUserAgent, true)
            assert.strictEqual(
                service.config.customUserAgent![0][0].replace('---Insiders', ''),
                `AWS-Toolkit-For-VSCode/testPluginVersion Visual-Studio-Code/${version} ClientId/${clientId}`
            )
        })

        it('adds Client-Id to user agent', async function () {
            const service = await builder.createAwsService(S3Client)
            const clientId = getClientId(new GlobalState(new FakeMemento()))
            const regex = new RegExp(`ClientId/${clientId}`)
            assert.ok(service.config.customUserAgent![0][0].match(regex))
        })

        it('does not override custom user-agent if specified in options', async function () {
            const service = await builder.createAwsService(S3Client, {
                customUserAgent: [['CUSTOM USER AGENT']],
            })

            assert.strictEqual(service.config.customUserAgent![0][0], 'CUSTOM USER AGENT')
        })

        it('can use endpoint override', async function () {
            const settings = new TestSettings()
            await settings.update('aws.dev.endpoints', { s3: 'http://example.com' })

            const service = await builder.createAwsService(
                S3Client,
                {
                    customUserAgent: [['CUSTOM USER AGENT']],
                },
                undefined,
                undefined,
                new DevSettings(settings)
            )

            assert.strictEqual((await service.config.endpoint!()).hostname, 'example.com')
        })

        it('does not clobber endpoint setting if no override is present', async function () {
            const settings = new TestSettings()

            const service = await builder.createAwsService(
                S3Client,
                {
                    customUserAgent: [['CUSTOM USER AGENT']],
                    endpoint: 'http://example.com',
                },
                undefined,
                undefined,
                new DevSettings(settings)
            )

            assert.strictEqual((await service.config.endpoint!()).hostname, 'example.com')
        })

        describe('middleware', function () {
            // Replaces the AWS SDK v2 `onRequestSetup` request listeners, which have no v3 equivalent.
            it('applies custom middleware to the client', async function () {
                let applied = false
                const middleware: Middleware = {
                    apply: (stack) => {
                        applied = true
                        stack.add((next: any) => async (args: any) => next(args), {
                            step: 'deserialize',
                            name: 'testMiddleware',
                        })
                    },
                }

                await builder.createAwsService(S3Client, { customMiddleware: [middleware] })

                assert.ok(applied)
            })
        })
    })
})
