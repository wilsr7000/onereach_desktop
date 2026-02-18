'use strict';

/**
 * Shared constants for the Spaces subsystem.
 * Centralises magic strings so they are defined in one place.
 */

const UNCLASSIFIED_SPACE = 'unclassified';
const GSX_AGENT_SPACE = 'gsx-agent';

const GSX_AGENT_SPACE_NAME = 'GSX Agent';
const GSX_AGENT_SPACE_ICON = '●';
const GSX_AGENT_SPACE_COLOR = '#8b5cf6';

const SYSTEM_ITEMS = Object.freeze({
  MAIN_CONTEXT: 'gsx-agent-main-context',
  PROFILE: 'gsx-agent-profile',
});

const PROTECTED_ITEM_IDS = Object.freeze([SYSTEM_ITEMS.MAIN_CONTEXT, SYSTEM_ITEMS.PROFILE]);

module.exports = {
  UNCLASSIFIED_SPACE,
  GSX_AGENT_SPACE,
  GSX_AGENT_SPACE_NAME,
  GSX_AGENT_SPACE_ICON,
  GSX_AGENT_SPACE_COLOR,
  SYSTEM_ITEMS,
  PROTECTED_ITEM_IDS,
};
