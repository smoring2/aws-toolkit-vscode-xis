/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import { filterTrustedNotifications, isTrustedExtensionId, isTrustedUrl } from '../../notifications/validation'
import { ToolkitNotification } from '../../notifications/types'

describe('Notification Validation', function () {
    describe('isTrustedUrl', function () {
        it('accepts HTTPS URLs from amazonaws.com', function () {
            assert.strictEqual(isTrustedUrl('https://idetoolkits-hostedfiles.amazonaws.com/test'), true)
        })

        it('accepts HTTPS URLs from amazon.com', function () {
            assert.strictEqual(isTrustedUrl('https://aws.amazon.com/visualstudiocode/'), true)
        })

        it('accepts HTTPS URLs from amazonwebservices.com', function () {
            assert.strictEqual(isTrustedUrl('https://docs.amazonwebservices.com/page'), true)
        })

        it('accepts HTTPS URLs from .aws TLD', function () {
            assert.strictEqual(isTrustedUrl('https://console.aws/test'), true)
        })

        it('rejects HTTP URLs', function () {
            assert.strictEqual(isTrustedUrl('http://aws.amazon.com/test'), false)
        })

        it('rejects untrusted domains', function () {
            assert.strictEqual(isTrustedUrl('https://evil.com/test'), false)
        })

        it('rejects domains that look like amazon but are not', function () {
            assert.strictEqual(isTrustedUrl('https://notamazon.com/test'), false)
            assert.strictEqual(isTrustedUrl('https://amazonaws.com.evil.com/test'), false)
        })

        it('rejects invalid URLs', function () {
            assert.strictEqual(isTrustedUrl('not-a-url'), false)
        })

        it('rejects javascript: protocol', function () {
            assert.strictEqual(isTrustedUrl('javascript:alert(1)'), false)
        })
    })

    describe('isTrustedExtensionId', function () {
        it('accepts amazonwebservices publisher extensions', function () {
            assert.strictEqual(isTrustedExtensionId('amazonwebservices.aws-toolkit-vscode'), true)
            assert.strictEqual(isTrustedExtensionId('amazonwebservices.amazon-q-vscode'), true)
        })

        it('rejects non-amazonwebservices publisher extensions', function () {
            assert.strictEqual(isTrustedExtensionId('evil-publisher.malicious-ext'), false)
            assert.strictEqual(isTrustedExtensionId('ms-python.python'), false)
        })

        it('rejects empty extension IDs', function () {
            assert.strictEqual(isTrustedExtensionId(''), false)
        })
    })

    describe('filterTrustedNotifications', function () {
        it('keeps notifications with trusted URLs', function () {
            const notifications: ToolkitNotification[] = [
                {
                    id: 'safe-1',
                    displayIf: { extensionId: 'amazonwebservices.amazon-q-vscode' },
                    uiRenderInstructions: {
                        content: { 'en-US': { title: 'test', description: 'test' } },
                        onReceive: 'toast',
                        onClick: { type: 'openUrl', url: 'https://aws.amazon.com/page' },
                    },
                },
            ]
            const result = filterTrustedNotifications(notifications)
            assert.strictEqual(result.length, 1)
        })

        it('filters out notifications with untrusted onClick URLs', function () {
            const notifications: ToolkitNotification[] = [
                {
                    id: 'evil-1',
                    displayIf: { extensionId: 'amazonwebservices.amazon-q-vscode' },
                    uiRenderInstructions: {
                        content: { 'en-US': { title: 'test', description: 'test' } },
                        onReceive: 'toast',
                        onClick: { type: 'openUrl', url: 'https://evil.com/phishing' },
                    },
                },
            ]
            const result = filterTrustedNotifications(notifications)
            assert.strictEqual(result.length, 0)
        })

        it('filters out notifications with untrusted action URLs', function () {
            const notifications: ToolkitNotification[] = [
                {
                    id: 'evil-2',
                    displayIf: { extensionId: 'amazonwebservices.amazon-q-vscode' },
                    uiRenderInstructions: {
                        content: { 'en-US': { title: 'test', description: 'test' } },
                        onReceive: 'toast',
                        onClick: { type: 'modal' },
                        actions: [
                            {
                                type: 'openUrl',
                                url: 'https://evil.com/malware',
                                displayText: { 'en-US': 'Click me' },
                            },
                        ],
                    },
                },
            ]
            const result = filterTrustedNotifications(notifications)
            assert.strictEqual(result.length, 0)
        })

        it('filters out notifications with untrusted extension IDs for updateAndReload', function () {
            const notifications: ToolkitNotification[] = [
                {
                    id: 'evil-3',
                    displayIf: { extensionId: 'evil-publisher.malicious-ext' },
                    uiRenderInstructions: {
                        content: { 'en-US': { title: 'test', description: 'test' } },
                        onReceive: 'modal',
                        onClick: { type: 'modal' },
                        actions: [
                            {
                                type: 'updateAndReload',
                                displayText: { 'en-US': 'Update' },
                            },
                        ],
                    },
                },
            ]
            const result = filterTrustedNotifications(notifications)
            assert.strictEqual(result.length, 0)
        })

        it('keeps notifications with trusted extension IDs for updateAndReload', function () {
            const notifications: ToolkitNotification[] = [
                {
                    id: 'safe-2',
                    displayIf: { extensionId: 'amazonwebservices.amazon-q-vscode' },
                    uiRenderInstructions: {
                        content: { 'en-US': { title: 'test', description: 'test' } },
                        onReceive: 'modal',
                        onClick: { type: 'modal' },
                        actions: [
                            {
                                type: 'updateAndReload',
                                displayText: { 'en-US': 'Update' },
                            },
                        ],
                    },
                },
            ]
            const result = filterTrustedNotifications(notifications)
            assert.strictEqual(result.length, 1)
        })

        it('keeps notifications with openTextDocument onClick (no URL)', function () {
            const notifications: ToolkitNotification[] = [
                {
                    id: 'safe-3',
                    displayIf: { extensionId: 'amazonwebservices.amazon-q-vscode' },
                    uiRenderInstructions: {
                        content: { 'en-US': { title: 'test', description: 'test' } },
                        onReceive: 'toast',
                        onClick: { type: 'openTextDocument' },
                    },
                },
            ]
            const result = filterTrustedNotifications(notifications)
            assert.strictEqual(result.length, 1)
        })
    })
})
