/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { getLogger } from '../shared/logger/logger'
import { ToolkitNotification } from './types'

const logger = getLogger('notifications')

/**
 * Trusted URL hostname patterns for notification openUrl actions.
 * Only URLs matching these patterns will be opened.
 */
const trustedUrlHostSuffixes: readonly string[] = [
    '.amazonaws.com',
    '.amazon.com',
    '.aws.amazon.com',
    '.aws',
    '.amazonwebservices.com',
]

/**
 * Trusted extension publisher prefix for updateAndReload actions.
 * Only extensions from this publisher can be installed via notifications.
 */
const trustedExtensionPublisher = 'amazonwebservices.'

/**
 * Validates that a URL is from a trusted domain before opening.
 * Returns true if the URL is safe to open, false otherwise.
 */
export function isTrustedUrl(url: string): boolean {
    try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'https:') {
            logger.warn('Notification URL rejected: non-HTTPS protocol: %s', url)
            return false
        }
        const hostname = parsed.hostname.toLowerCase()
        const isTrusted = trustedUrlHostSuffixes.some(
            (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix)
        )
        if (!isTrusted) {
            logger.warn('Notification URL rejected: untrusted hostname: %s', url)
        }
        return isTrusted
    } catch {
        logger.warn('Notification URL rejected: invalid URL: %s', url)
        return false
    }
}

/**
 * Validates that an extension ID belongs to a trusted publisher before installing.
 * Returns true if the extension ID is safe to install, false otherwise.
 */
export function isTrustedExtensionId(extensionId: string): boolean {
    const isTrusted = extensionId.toLowerCase().startsWith(trustedExtensionPublisher)
    if (!isTrusted) {
        logger.warn('Notification extension install rejected: untrusted extension ID: %s', extensionId)
    }
    return isTrusted
}

/**
 * Validates a parsed notification payload, filtering out notifications with untrusted actions.
 * Returns only notifications that pass all security checks.
 */
export function filterTrustedNotifications(notifications: ToolkitNotification[]): ToolkitNotification[] {
    return notifications.filter((n) => {
        // Validate onClick URL if present
        if (n.uiRenderInstructions.onClick.type === 'openUrl') {
            const url = n.uiRenderInstructions.onClick.url
            if (!url || !isTrustedUrl(url)) {
                logger.warn('Notification %s filtered: untrusted onClick URL', n.id)
                return false
            }
        }

        // Validate action URLs and extension IDs
        const actions = n.uiRenderInstructions.actions ?? []
        for (const action of actions) {
            if (action.type === 'openUrl') {
                if (!action.url || !isTrustedUrl(action.url)) {
                    logger.warn('Notification %s filtered: untrusted action URL', n.id)
                    return false
                }
            }
            if (action.type === 'updateAndReload') {
                if (!isTrustedExtensionId(n.displayIf.extensionId)) {
                    logger.warn('Notification %s filtered: untrusted extension ID for updateAndReload', n.id)
                    return false
                }
            }
        }

        return true
    })
}
