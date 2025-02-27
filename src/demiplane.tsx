/** @format */
import createLogger from './log';
import { getStorage, setStorage } from './storage';
import { IRoll, ThreeDDiceRollEvent, ThreeDDice, ITheme, ThreeDDiceAPI, IUser } from 'dddice-js';
import notify from './utils/notify';
import { Notify } from 'notiflix/build/notiflix-notify-aio';

const log = createLogger('demiplane');
log.info('DDDICE Demiplane');

Notify.init({
  useIcon: false,
  fontSize: '16px',
  timeout: 10000,
  clickToClose: true,
});

let dddice: ThreeDDice;
let canvasElement: HTMLCanvasElement;
let user: IUser;
let isInitialized = false; // Track initialization state
let watchingStorage = false; // Track if we're already watching storage

// Game system detection and configuration
enum GameSystem {
  DAGGERHEART = 'daggerheart',
  PATHFINDER = 'pathfinder',
  UNKNOWN = 'unknown',
}

interface GameConfig {
  pathRegex: RegExp;
  storageKeyPattern: string;
  getRollName: (roll: DiceRoll) => string;
  getTypeResult: (roll: DiceRoll) => string;
  processDice: (roll: DiceRoll) => Array<{
    type: string;
    value: number;
    theme: string | undefined;
    label?: string;
  }>;
  getCharacterNameSelector?: string;
}

const gameConfigs: Record<GameSystem, GameConfig> = {
  [GameSystem.DAGGERHEART]: {
    pathRegex: /^\/nexus\/daggerheart\/character-sheet\/([^/]+)/,
    storageKeyPattern: '{uuid}-dice-history',
    getRollName: roll => {
      const purposeModifier = roll.modifiersParsed.find(m => m.purpose === 'misc');
      const nameModifier = roll.modifiersParsed[2]; // Based on the example, this seems to be where the ability/spell name is

      if (purposeModifier?.value && nameModifier?.value) {
        return `${purposeModifier.value}: ${nameModifier.value}`;
      }
      return roll.name;
    },
    getTypeResult: roll => {
      if (roll.result.status.slug === 'critical-success') {
        return ' Critical Success!';
      }

      const hasFear = roll.dice.some(d => d.slug === 'fear');
      const hasHope = roll.dice.some(d => d.slug === 'hope');

      if (hasFear) return ' with Fear';
      if (hasHope) return ' with Hope';
      return '';
    },
    processDice: roll => {
      const diceArray = [];

      roll.result.dice.forEach(die => {
        const value = die.config.isNegative ? -die.value : die.value;
        const label = die.config.name;

        diceArray.push({
          type: die.value > 0 ? die.die : 'mod',
          value,
          theme: undefined, // Will be set in sendRollRequest based on die type
          label,
        });
      });

      // Add static modifier if present
      const modifierValue = roll.modifiersParsed.find(m => m.purpose === 'add')?.value;
      if (typeof modifierValue === 'number' && modifierValue !== 0) {
        diceArray.push({
          type: 'mod',
          value: modifierValue,
          theme: undefined,
        });
      }

      return diceArray;
    },
    getCharacterNameSelector:
      '.MuiGrid-root.MuiGrid-item.text-block.character-name.css-1ipveys .text-block__text.MuiBox-root.css-1dyfylb',
  },
  [GameSystem.PATHFINDER]: {
    pathRegex: /^\/nexus\/pathfinder2e\/character-sheet\/([^/]+)/,
    storageKeyPattern: '{uuid}-dicerolls',
    getRollName: roll => {
      // Use roll name and origin for a complete description
      if (roll.origin) {
        return `${roll.name} (${roll.origin})`;
      }
      return roll.name;
    },
    getTypeResult: roll => {
      // Check for critical success/failure based on crit value if available
      if (roll?.result?.crit === 1) {
        return ' Critical Success!';
      } else if (roll?.result?.crit === -1) {
        return ' Critical Failure!';
      }
      return '';
    },
    processDice: roll => {
      const diceArray = [];

      // Check if we have valid roll data
      if (!roll?.result?.raw_dice?.parts) {
        log.debug('Invalid Pathfinder roll data structure:', roll);
        return diceArray;
      }

      // Process each part of the roll (dice, operators, constants)
      for (const part of roll.result.raw_dice.parts) {
        if (part.type === 'dice') {
          // Process all dice in this part
          for (const die of part.dice) {
            if (die.type === 'single_dice') {
              diceArray.push({
                type: `d${die.size}`, // d20, d4, etc.
                value: die.value,
                theme: undefined,
                label: `${part.num_dice}d${die.size}`,
              });
            }
          }
        } else if (part.type === 'constant') {
          // Add modifiers as static values
          diceArray.push({
            type: 'mod',
            value: part.value,
            theme: undefined,
          });
        }
      }

      return diceArray;
    },
    getCharacterNameSelector: '.character-name', // Update with the correct selector for Pathfinder
  },
  [GameSystem.UNKNOWN]: {
    pathRegex: /^\/nexus\/([^/]+)\/character-sheet\/([^/]+)/,
    storageKeyPattern: '{uuid}-dice-history',
    getRollName: roll => roll.name,
    getTypeResult: () => '',
    processDice: roll => {
      const diceArray = [];

      roll.result.dice.forEach(die => {
        const value = die.config.isNegative ? -die.value : die.value;

        diceArray.push({
          type: die.value > 0 ? die.die : 'mod',
          value,
          theme: undefined,
        });
      });

      // Add static modifier if present
      const modifierValue = roll.modifiersParsed.find(m => m.purpose === 'add')?.value;
      if (typeof modifierValue === 'number' && modifierValue !== 0) {
        diceArray.push({
          type: 'mod',
          value: modifierValue,
          theme: undefined,
        });
      }

      return diceArray;
    },
  },
};

let currentGameSystem: GameSystem = GameSystem.UNKNOWN;

function detectGameSystem(): { system: GameSystem; uuid: string | null } {
  for (const [system, config] of Object.entries(gameConfigs)) {
    const match = window.location.pathname.match(config.pathRegex);
    if (match) {
      // Store the detected game system in extension storage
      setStorage({ gameSystem: system });
      return {
        system: system as GameSystem,
        uuid: match[match.length - 1],
      };
    }
  }

  // If no specific system is detected, store the UNKNOWN type
  setStorage({ gameSystem: GameSystem.UNKNOWN });
  return { system: GameSystem.UNKNOWN, uuid: null };
}

interface DiceRoll {
  // Common properties
  name: string;
  type?: string;

  // Daggerheart specific properties
  dice?: Array<{
    slug: string;
    die: string;
    label: string;
    image: string;
    pooledImage: string;
  }>;
  roll?: string;
  modifiersParsed?: Array<{
    value: number | string;
    purpose: string;
    rollString: string;
  }>;
  rerolled?: boolean;

  // Pathfinder specific properties
  origin?: string;

  // Result can have different structures
  result: {
    // Daggerheart structure
    dice?: Array<{
      id: number;
      die: string;
      value: number;
      maxValue: number;
      slug: string;
      is_kept: boolean;
      originalValue?: number;
      config: {
        priority: number;
        dieSlug: string;
        slug: string;
        image: string;
        rerollable: boolean;
        name: string;
        isNegative?: boolean;
      };
    }>;

    // Common properties
    total: number;

    // Daggerheart specific
    maxTotal?: number;
    crit?: number;
    status?: {
      priority: number;
      slug: string;
      label: string;
      conditions: Array<any>;
    };

    // Pathfinder specific
    raw_dice?: {
      parts: Array<{
        type: string;
        value: number;
        annotation?: string;
        is_crit?: number;
        text?: string;
        operators?: Array<any>;

        // For dice type
        dice?: Array<{
          type: string;
          value: number;
          size: number;
          is_kept: boolean;
          rolls: Array<number>;
          exploded: boolean;
          imploded: boolean;
        }>;
        num_kept?: number;
        num_dice?: number;
        dice_size?: number;
      }>;
    };
    error?: string;
  };
}

function processRoll(roll: DiceRoll): void {
  log.debug('Processing roll:', {
    name: roll.name,
    // Safely handle the roll.dice property which may not exist in Pathfinder
    dice: roll.dice ? roll.dice.map(d => d.die) : 'not available',
    modifiers: roll.modifiersParsed,
    result: roll.result,
  });

  const { system } = detectGameSystem();
  currentGameSystem = system;

  const diceArray = gameConfigs[system].processDice(roll);

  log.debug('Prepared dice array for 3D roll:', diceArray);
  sendRollRequest(diceArray, roll);
}

async function watchLocalStorage(): Promise<void> {
  const { system, uuid } = detectGameSystem();
  currentGameSystem = system;
  log.debug('Detected game system:', system);
  log.debug('Detected character UUID:', uuid);
  log.debug('Current watchingStorage state:', watchingStorage);

  if (!uuid) {
    log.debug('No character UUID found in URL');
    return;
  }

  // If we're already watching storage for this session, don't set up another watcher
  if (watchingStorage) {
    log.debug('Already watching localStorage');
    return;
  }

  const storageKey = gameConfigs[system].storageKeyPattern.replace('{uuid}', uuid);
  log.debug(`Watching localStorage key: ${storageKey} for game system: ${system}`);

  // Initialize lastRolls with current state to prevent rolling on page load
  const historyString = localStorage.getItem(storageKey);
  log.debug('Initial localStorage content:', historyString ? 'Found data' : 'No data');
  let lastRolls: DiceRoll[] | null = historyString ? JSON.parse(historyString) : null;

  const checkForNewRolls = async () => {
    // Re-run init to update character name if needed (this handles character name changes)
    init();

    const historyString = localStorage.getItem(storageKey);
    if (!historyString) {
      log.debug('No dice history found in localStorage for key:', storageKey);
      return;
    }

    try {
      const currentRolls: DiceRoll[] = JSON.parse(historyString);
      log.debug('Current rolls count:', currentRolls.length);

      if (
        !lastRolls ||
        (currentRolls[0] && JSON.stringify(currentRolls[0]) !== JSON.stringify(lastRolls[0]))
      ) {
        // Process only the newest roll
        const newestRoll = currentRolls[0];
        if (newestRoll) {
          log.debug(
            'Processing roll:',
            newestRoll.name,
            'with dice:',
            // Safely handle dice property which may not exist in Pathfinder
            newestRoll.dice?.map(d => d.die)?.join(', ') || 'no dice array',
          );
          processRoll(newestRoll);
        }
        lastRolls = currentRolls;
      } else {
        log.debug('No new rolls detected');
      }
    } catch (e) {
      log.debug('Error parsing dice history:', e);
    }
  };

  log.debug('Setting up interval for checking new rolls');
  // Set up the interval to watch for future changes
  setInterval(checkForNewRolls, 1000);
  watchingStorage = true; // Mark that we're watching storage
  log.debug('watchingStorage flag set to true');

  // Run an immediate check for dice history
  checkForNewRolls();
}

async function sendRollRequest(
  roll: Array<{ type: string; value: number; theme: string | undefined; label?: string }>,
  originalRoll: DiceRoll,
): Promise<void> {
  const [room, defaultTheme, hopeTheme, fearTheme] = await Promise.all([
    getStorage('room'),
    getStorage('theme'),
    getStorage('hopeTheme'),
    getStorage('fearTheme'),
  ]);

  if (!dddice?.api) {
    notify(
      `dddice extension hasn't been set up yet. Please open the extension pop up via the extensions menu`,
    );
    return;
  }

  if (!room?.slug) {
    notify(
      'No dddice room has been selected. Please open the dddice extension pop up and select a room to roll in',
    );
    return;
  }

  // Wait for initialization using public methods
  if (dddice) {
    log.debug('Waiting for 3D engine to initialize...');
    try {
      await new Promise<void>((resolve, reject) => {
        let attempts = 0;
        const maxAttempts = 50; // 5 seconds total
        const checkReady = () => {
          // Use a try-catch to check if the engine is ready
          try {
            // Attempt to access a method that requires initialization
            dddice.clear();
            resolve();
          } catch (e) {
            if (attempts >= maxAttempts) {
              reject(new Error('3D engine initialization timeout'));
            } else {
              attempts++;
              setTimeout(checkReady, 100);
            }
          }
        };
        checkReady();
      });
    } catch (e) {
      log.error('Failed to initialize 3D engine:', e);
      notify('Failed to initialize 3D engine. Please refresh the page.');
      return;
    }
  }

  try {
    log.debug('Sending roll:', roll);
    // Assign themes based on game system and die type
    roll.forEach(die => {
      if (currentGameSystem === GameSystem.DAGGERHEART) {
        // Daggerheart-specific theme assignment
        if (die.label === 'Hope') {
          die.theme = hopeTheme?.id;
        } else if (die.label === 'Fear') {
          die.theme = fearTheme?.id;
        } else {
          die.theme = defaultTheme?.id;
        }
      } else {
        // Default theme for other game systems
        die.theme = defaultTheme?.id;
      }
    });

    if (!defaultTheme?.id) {
      log.debug('No theme selected, using default');
    }

    const { system } = detectGameSystem();
    const label =
      gameConfigs[system].getRollName(originalRoll) +
      gameConfigs[system].getTypeResult(originalRoll);
    await dddice.api.roll.create(roll, { label: label });
  } catch (e: any) {
    log.error('Roll creation failed:', e);
    notify(
      `Failed to create roll: ${e.response?.data?.data?.message ?? e.message ?? 'Unknown error'}`,
    );
  }
}

async function initializeSDK(): Promise<void> {
  const [apiKey, room, theme, renderMode] = await Promise.all([
    getStorage('apiKey'),
    getStorage('room'),
    getStorage('theme'),
    getStorage('render mode'),
  ]);

  if (!apiKey) {
    log.debug('no api key');
    return;
  }

  log.debug('initializeSDK', renderMode);
  if (dddice) {
    if (canvasElement) canvasElement.remove();
    if (dddice.api?.disconnect) dddice.api.disconnect();
    dddice.stop();
  }

  try {
    if (renderMode === undefined || renderMode) {
      canvasElement = document.createElement('canvas');
      canvasElement.id = 'dddice-canvas';
      canvasElement.style.cssText =
        'top:0px; position:fixed; pointer-events:none; z-index:100000; opacity:100; height:100vh; width:100vw;';
      document.body.appendChild(canvasElement);

      dddice = new ThreeDDice().initialize(canvasElement, apiKey, undefined, 'Demiplane');
      dddice.on(ThreeDDiceRollEvent.RollFinished, (roll: IRoll) => notifyRollFinished(roll));
      dddice.start();
      if (room?.slug) {
        dddice.connect(room.slug);
      }
    } else {
      dddice = new ThreeDDice();
      dddice.api = new ThreeDDiceAPI(apiKey, 'Demiplane');
      if (room?.slug) {
        dddice.api.connect(room.slug);
      }
      dddice.api?.listen(ThreeDDiceRollEvent.RollCreated, (roll: IRoll) =>
        setTimeout(() => notifyRollCreated(roll), 1500),
      );
    }
    if (theme) preloadTheme(theme);

    // Mark initialization as complete
    isInitialized = true;
    // Store initialization state in extension storage
    setStorage({ demiplane_initialized: true });

    // Start watching for dice rolls
    log.debug('Starting localStorage watch from initializeSDK');
    watchLocalStorage();
  } catch (e: any) {
    log.debug(e);
    notify(`${e.response?.data?.data?.message ?? e}`);
  }
}

function notifyRollFinished(roll: IRoll) {
  Notify.success(generateNotificationMessage(roll));
}

function notifyRollCreated(roll: IRoll) {
  Notify.info(generateNotificationMessage(roll));
}

function generateNotificationMessage(roll: IRoll) {
  const roller = roll.room.participants.find(
    participant => participant.user.uuid === roll.user.uuid,
  );

  return `${roller?.username ?? 'Unknown'}: ${roll.equation} = ${
    typeof roll.total_value === 'object' ? '⚠' : roll.total_value
  }`;
}

function preloadTheme(theme: ITheme): Promise<void> {
  if (!theme || !dddice) {
    log.debug('Cannot preload theme: missing theme or dddice instance');
    return Promise.resolve();
  }

  try {
    dddice.loadTheme(theme, true);
    // Just execute loadThemeResources and return void
    dddice.loadThemeResources(theme.id, true);
    return Promise.resolve();
  } catch (e) {
    log.debug('Error preloading theme:', e);
    return Promise.reject(e);
  }
}

async function init() {
  const { system, uuid } = detectGameSystem();
  currentGameSystem = system;

  if (!uuid) {
    log.debug('uninit: not on a character sheet page');
    const currentCanvas = document.getElementById('dddice-canvas');
    if (currentCanvas) {
      currentCanvas.remove();
      dddice = undefined as unknown as ThreeDDice;
    }
    return;
  }

  log.debug(`init: on ${system} character sheet page`);

  // Check if we're already initialized with the API ready
  if (!isInitialized && !dddice?.api) {
    // Check if previously initialized in storage
    const initialized = await getStorage('demiplane_initialized');
    const apiKey = await getStorage('apiKey');

    log.debug('Checking initialization state:', { initialized, apiKeyExists: !!apiKey });

    if (apiKey) {
      // If API key exists, initialize the SDK
      await initializeSDK();
    }
  } else {
    log.debug('Already initialized, updating state if needed');
    // We're already initialized, just make sure we're watching localStorage
    if (!watchingStorage) {
      log.debug('Starting localStorage watch for dice rolls');
      watchLocalStorage();
    }

    // Update character name if needed
    const room = await getStorage('room');
    if (!user) {
      try {
        user = (await dddice?.api?.user.get())?.data;
      } catch (e) {
        log.debug('Failed to get user', e);
      }
    }

    const config = gameConfigs[system];
    const characterNameSelector = config.getCharacterNameSelector;

    if (characterNameSelector) {
      const characterName = document.querySelector<HTMLElement>(characterNameSelector)?.textContent;

      if (room && user && characterName) {
        const userParticipant = room.participants.find(
          ({ user: { uuid: participantUuid } }) => participantUuid === user.uuid,
        );

        if (userParticipant && characterName && userParticipant.username !== characterName) {
          userParticipant.username = characterName;
          setStorage({ room });
          await dddice?.api?.room.updateParticipant(room.slug, userParticipant.id, {
            username: characterName,
          });
        }
      }
    }

    if (dddice?.canvas) dddice.resize(window.innerWidth, window.innerHeight);
  }
}

document.addEventListener('click', () => {
  if (dddice && !dddice?.isDiceThrowing) dddice.clear();
});

// @ts-ignore
chrome.runtime.onMessage.addListener(function (message) {
  switch (message.type) {
    case 'reloadDiceEngine':
      initializeSDK();
      break;
    case 'preloadTheme':
      preloadTheme(message.theme);
      break;
  }
});

// Initialize on page load and resize
window.addEventListener('load', () => init());
window.addEventListener('resize', () => init());

// Also initialize when the script first runs
init();

// Add listener for URL changes (for single-page app navigation)
let lastUrl = window.location.href;
new MutationObserver(() => {
  const currentUrl = window.location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    log.debug('URL changed, reinitializing extension');
    init();
  }
}).observe(document, { subtree: true, childList: true });
