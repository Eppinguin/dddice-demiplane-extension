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

// Global state variables
let dddice: ThreeDDice;
let canvasElement: HTMLCanvasElement;
let user: IUser;
let isInitialized = false;
let watchingStorage = false;
let initializationAttempts = 0;
const MAX_INITIALIZATION_ATTEMPTS = 3;
let reconnectionTimer: ReturnType<typeof setTimeout> | null = null;

enum GameSystem {
  AVATARLEGENDS = 'avatarlegends',
  DAGGERHEART = 'daggerheart',
  COSMERERPG = 'cosmererpg',
  UNKNOWN = 'unknown',
}

interface GameConfig {
  pathRegex: RegExp;
  storageKeyPattern: string;
  getRollName: (roll: DiceRoll) => string;
  getTypeResult: (roll: DiceRoll) => string;
  processDice: (roll: DiceRoll) => {
    dice: Array<{
      type: string;
      value: number;
      theme: string | undefined;
      label?: string;
      groupSlug?: string;
    }>;
    operator: object;
    plotDice?: {
      type: string;
      value: number;
      theme: string | undefined;
      label?: string;
      groupSlug?: string;
    };
  };
  getCharacterNameSelector?: string;
}

interface ModifierEntry {
  value: number | string;
  purpose: string;
  rollString: string;
}

interface DiceRoll {
  name: string;
  type?: string;
  dice?: Array<{
    slug: string;
    die: string;
    type?: string;
    label: string;
    image: string;
    pooledImage: string;
  }>;
  roll?: string;
  modifiersParsed?: ModifierEntry[] | ModifierEntry[][] | ModifierEntry;
  rerolled?: boolean;
  results?: Array<{
    dice: Array<{
      originalValue: any;
      id: number;
      die: string;
      value: number;
      maxValue: number;
      slug: string;
      is_kept: boolean;
      groupSlug?: string;
      config: {
        priority: number;
        dieSlug: string;
        slug: string;
        image: string;
        rerollable: boolean;
        name: string;
        isNegative?: boolean;
        overrideValue?: number;
      };
    }>;
    total: number;
    maxTotal: number;
    crit: number;
    status?: {
      priority: number;
      slug: string;
      label: string;
      conditions: Array<any>;
    };
  }>;
  origin?: string;
  result: {
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
        overrideValue?: number;
      };
    }>;
    total: number;
    maxTotal?: number;
    crit?: number;
    status?: {
      priority: number;
      slug: string;
      label: string;
      conditions: Array<any>;
    };
    raw_dice?: {
      parts: Array<{
        type: string;
        value: number;
        annotation?: string;
        is_crit?: number;
        text?: string;
        operators?: Array<any>;
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

const baseConfig: GameConfig = {
  pathRegex: /^\/nexus\/([^/]+)\/character-sheet\/([^/]+)/,
  storageKeyPattern: '{uuid}-dice-history',
  getRollName: roll => roll.name + (roll.origin ? ` (${roll.origin})` : ''),
  getTypeResult: () => '',
  processDice: roll => {
    const diceArray = [];
    const negativeIndices: number[] = [];

    if (roll?.result?.raw_dice?.parts) {
      let lastOperator = '+';

      for (const part of roll.result.raw_dice.parts) {
        if (part.type === 'dice') {
          for (const die of part.dice) {
            if (die.type === 'single_dice') {
              const dieIndex = diceArray.length;
              diceArray.push({
                type: `d${die.size}`,
                value: die.value,
                theme: undefined,
                label: `${part.num_dice}d${die.size}`,
              });

              if (lastOperator === '-') {
                negativeIndices.push(dieIndex);
              }
            }
          }
        } else if (part.type === 'operator' && typeof part.value === 'string' && part.value) {
          lastOperator = part.value;
        } else if (part.type === 'constant') {
          diceArray.push({
            type: 'mod',
            value: lastOperator === '-' ? -part.value : part.value,
            theme: undefined,
          });
        }
      }
    } else if (roll?.result?.dice) {
      roll.result.dice.forEach(die => {
        log.debug('Processing die:', die);
        const dieIndex = diceArray.length;

        if (die.value < 0 && die.die !== 'mod') {
          diceArray.push({
            type: die.die,
            value: Math.abs(die.value),
            theme: undefined,
          });
          negativeIndices.push(dieIndex);
        } else {
          diceArray.push({
            type: die.value > 0 ? die.die : 'mod',
            value: die.value,
            theme: undefined,
          });
        }
      });

      if (roll.modifiersParsed && Array.isArray(roll.modifiersParsed)) {
        const modifiers = roll.modifiersParsed as ModifierEntry[];
        const addModifier = modifiers.find(m => m.purpose === 'add');
        if (addModifier && typeof addModifier.value === 'number' && addModifier.value !== 0) {
          diceArray.push({
            type: 'mod',
            value: addModifier.value,
            theme: undefined,
          });
        }
      }
    }

    const operator = negativeIndices.length > 0 ? { '*': { '-1': negativeIndices } } : {};
    return { dice: diceArray, operator, plotDice: undefined };
  },
};

const gameConfigs: Record<GameSystem, GameConfig> = {
  [GameSystem.AVATARLEGENDS]: {
    ...baseConfig,
    pathRegex: /^\/nexus\/avatarlegends\/character-sheet\/([^/]+)/,
    storageKeyPattern: '{uuid}-dicerolls',
    getTypeResult: roll => {
      if (roll.result.total > 10) {
        return ' (strong hit)';
      }
      if (roll.result.total > 7) {
        return ' (weak hit)';
      }
      return ' (miss)';
    },
  },
  [GameSystem.DAGGERHEART]: {
    ...baseConfig,
    pathRegex: /^\/nexus\/daggerheart\/(character-sheet|npc-sheet)\/([^/]+)/,
    getRollName: roll => {
      log.debug('Roll:', roll);
      if (Array.isArray(roll.modifiersParsed)) {
        const modifiers = roll.modifiersParsed as ModifierEntry[];
        const miscValues = modifiers
          .filter(m => m.purpose === 'misc' && m.value !== 'damage' && typeof m.value === 'string')
          .map(m => m.value);

        if (miscValues.length > 0) {
          return miscValues.join(': ');
        }
      }
      return roll.name;
    },
    getTypeResult: roll => {
      if (roll?.result?.status?.slug === 'critical-success') {
        return ' Critical Success!';
      }
      if (roll?.result?.status?.slug === 'roll-with-hope') {
        return ' with Hope';
      }
      if (roll?.result?.status?.slug === 'roll-with-fear') {
        return ' with Fear';
      }
      return '';
    },
    processDice: roll => {
      const diceArray = [];
      const negativeIndices: number[] = [];

      roll.result.dice.forEach(die => {
        const label = die.config.name;
        log.debug('Processing die:', die);
        const dieIndex = diceArray.length;

        if (die.value < 0 && die.die !== 'mod') {
          diceArray.push({
            type: die.die,
            value: Math.abs(die.value),
            theme: undefined,
            label,
          });
          negativeIndices.push(dieIndex);
        } else {
          diceArray.push({
            type: die.value > 0 ? die.die : 'mod',
            value: die.value,
            theme: undefined,
            label,
          });
        }
      });

      if (roll.modifiersParsed) {
        if (Array.isArray(roll.modifiersParsed)) {
          const modifiers = roll.modifiersParsed as ModifierEntry[];
          const addModifier = modifiers.find(m => m.purpose === 'add');
          if (addModifier && typeof addModifier.value === 'number' && addModifier.value !== 0) {
            diceArray.push({
              type: 'mod',
              value: addModifier.value,
              theme: undefined,
            });
          }
        } else if (
          !Array.isArray(roll.modifiersParsed) &&
          typeof roll.modifiersParsed === 'object'
        ) {
          const mod = roll.modifiersParsed as ModifierEntry;
          if (mod.purpose === 'add' && typeof mod.value === 'number' && mod.value !== 0) {
            diceArray.push({
              type: 'mod',
              value: mod.value,
              theme: undefined,
            });
          }
        }
      }

      const operator = negativeIndices.length > 0 ? { '*': { '-1': negativeIndices } } : {};
      return { dice: diceArray, operator, plotDice: undefined };
    },
    getCharacterNameSelector: '.character-name',
  },
  [GameSystem.COSMERERPG]: {
    ...baseConfig,
    pathRegex: /^\/nexus\/cosmererpg\/character-sheet\/([^/]+)/,
    getRollName: roll => {
      if (Array.isArray(roll.modifiersParsed)) {
        const firstGroup = roll.modifiersParsed[0];
        if (Array.isArray(firstGroup)) {
          const mods = firstGroup as ModifierEntry[];
          const purposeModifier = mods.find(m => m.purpose === 'misc');
          const nameModifier = mods.find(
            m => m.purpose === 'misc' && m.value !== purposeModifier?.value,
          );

          if (purposeModifier?.value && nameModifier?.value) {
            return `${purposeModifier.value}: ${nameModifier.value}`;
          }
        }
      }
      return roll.name;
    },
    getTypeResult: roll => {
      const plotDie = roll.dice?.find(d => d.slug === 'plot');
      let plotDieValue;

      if (roll.results && roll.results.length > 0) {
        const plotDieResult = roll.results[0]?.dice.find(d => d.slug === 'plot');
        plotDieValue = plotDieResult?.originalValue || plotDieResult?.value;
      }

      if (!plotDieValue && roll.result.dice) {
        const plotDieResult = roll.result.dice.find(d => d.slug === 'plot');
        plotDieValue = plotDieResult?.originalValue || plotDieResult?.value;
      }

      if (plotDie && plotDieValue) {
        if (plotDieValue === 5 || plotDieValue === 6) {
          return ' with Opportunity!';
        } else if (plotDieValue === 1 || plotDieValue === 2) {
          return ' with Complications';
        }
      }

      if (roll?.result?.status?.slug === 'opportunity') {
        return ' Opportunity!';
      } else if (roll?.result?.status?.slug === 'complication') {
        return ' Complications';
      }

      return '';
    },
    processDice: roll => {
      const diceArray = [];
      const negativeIndices: number[] = [];
      let operator = {};
      let plotDice = null;

      if (roll.dice && roll.dice.length > 0) {
        const hasKeepHighest = roll.dice.some(d => d.type === 'kh');
        const hasKeepLowest = roll.dice.some(d => d.type === 'kl');
        if (hasKeepHighest) {
          operator = { k: 'h1' };
        } else if (hasKeepLowest) {
          operator = { k: 'l1' };
        }
      }

      if (roll.results) {
        roll.results.forEach((result, index) => {
          result.dice.forEach(die => {
            const label = die.config.name;
            const isPlotDie = die.slug === 'plot';
            const groupSlug = die.groupSlug || (index === 0 ? 'main-d20-group' : 'damage-group');

            if (isPlotDie) {
              plotDice = {
                type: 'setback',
                value: die.originalValue || die.value,
                theme: undefined,
                label: 'Plot Die',
                groupSlug: 'plot-die',
              };
            } else {
              const dieIndex = diceArray.length;

              if (die.value < 0 && die.die !== 'mod') {
                diceArray.push({
                  type: die.die,
                  value: Math.abs(die.value),
                  theme: undefined,
                  label: label,
                  groupSlug: groupSlug,
                });
                negativeIndices.push(dieIndex);
              } else {
                diceArray.push({
                  type: die.value < 0 ? 'mod' : die.die,
                  value: die.value,
                  theme: undefined,
                  label: label,
                  groupSlug: groupSlug,
                });
              }
            }
          });

          if (roll.modifiersParsed && Array.isArray(roll.modifiersParsed)) {
            const modGroups = roll.modifiersParsed as ModifierEntry[][];
            const modGroup = modGroups[index];
            if (Array.isArray(modGroup)) {
              const addModifier = modGroup.find(m => m.purpose === 'add');
              if (addModifier && typeof addModifier.value === 'number' && addModifier.value !== 0) {
                diceArray.push({
                  type: 'mod',
                  value: addModifier.value,
                  theme: undefined,
                  groupSlug: index === 0 ? 'main-d20-group' : 'damage-group',
                });
              }
            }
          }
        });
      } else if (roll.result.dice) {
        roll.result.dice.forEach(die => {
          const value = die.config.isNegative ? -die.value : die.value;
          const label = die.config.name;
          const isPlotDie = die.slug === 'plot';

          if (isPlotDie) {
            plotDice = {
              type: 'setback',
              value: die.originalValue || value,
              theme: undefined,
              label: 'Plot Die',
              groupSlug: 'plot-die',
            };
          } else {
            const dieIndex = diceArray.length;

            if (value < 0 && die.die !== 'mod') {
              diceArray.push({
                type: die.die,
                value: Math.abs(value),
                theme: undefined,
                label: label,
              });
              negativeIndices.push(dieIndex);
            } else {
              diceArray.push({
                type: die.die,
                value: value,
                theme: undefined,
                label: label,
              });
            }
          }
        });
      }

      if (negativeIndices.length > 0) {
        operator = { ...operator, '*': { '-1': negativeIndices } };
      }

      return {
        dice: diceArray,
        operator,
        plotDice,
      };
    },
    getCharacterNameSelector: '.character-name',
  },
  [GameSystem.UNKNOWN]: {
    ...baseConfig,
  },
};

let currentGameSystem: GameSystem = GameSystem.UNKNOWN;

function detectGameSystem(): { system: GameSystem; uuid: string | null } {
  for (const [system, config] of Object.entries(gameConfigs)) {
    const match = window.location.pathname.match(config.pathRegex);
    if (match) {
      setStorage({ gameSystem: system });
      return {
        system: system as GameSystem,
        uuid: match[match.length - 1],
      };
    }
  }

  setStorage({ gameSystem: GameSystem.UNKNOWN });
  return { system: GameSystem.UNKNOWN, uuid: null };
}

function processRoll(roll: DiceRoll): void {
  log.debug('Processing roll:', {
    name: roll.name,
    dice: roll.dice ? roll.dice.map(d => d.die) : 'not available',
    modifiers: roll.modifiersParsed,
    result: roll.result,
  });

  const { system } = detectGameSystem();
  currentGameSystem = system;

  const result = gameConfigs[system].processDice(roll);
  const diceArray = result.dice;
  const operator = result.operator;

  log.debug('Prepared dice array for 3D roll:', diceArray);
  log.debug('Prepared operator for 3D roll:', operator);
  sendRollRequest(diceArray, roll, operator);
}

/**
 * Watch localStorage for dice roll changes
 */
async function watchLocalStorage(): Promise<void> {
  try {
    // Detect game system and character UUID
    const { system, uuid } = detectGameSystem();
    currentGameSystem = system;
    log.debug('Detected game system:', system);
    log.debug('Detected character UUID:', uuid);
    log.debug('Current watchingStorage state:', watchingStorage);

    // Early return if no UUID found
    if (!uuid) {
      log.debug('No character UUID found in URL');
      return;
    }

    // Prevent multiple watchers
    if (watchingStorage) {
      log.debug('Already watching localStorage');
      return;
    }

    // Determine storage keys to watch based on game system
    const storageKeys =
      system === GameSystem.UNKNOWN
        ? [
            gameConfigs[system].storageKeyPattern.replace('{uuid}', uuid),
            '{uuid}-dicerolls'.replace('{uuid}', uuid),
          ]
        : [gameConfigs[system].storageKeyPattern.replace('{uuid}', uuid)];

    log.debug(`Watching localStorage keys: ${storageKeys.join(', ')} for game system: ${system}`);

    // Initialize lastRolls from localStorage
    let lastRolls: DiceRoll[] | null = null;
    let foundInitialData = false;

    for (const key of storageKeys) {
      const historyString = localStorage.getItem(key);
      if (historyString) {
        try {
          lastRolls = JSON.parse(historyString);
          log.debug(`Found initial data in ${key}`);
          foundInitialData = true;
          break;
        } catch (e) {
          log.warn(`Error parsing initial dice history from ${key}:`, e);
        }
      }
    }

    if (!foundInitialData) {
      log.debug('No initial dice history found in any localStorage keys');
    }

    // Define the roll checking function
    const checkForNewRolls = async () => {
      if (!dddice?.api) {
        log.debug('dddice API not available, skipping roll check');
        return;
      }

      let currentRolls: DiceRoll[] | null = null;
      let foundKey = '';

      // Try to get rolls from each possible storage key
      for (const key of storageKeys) {
        const historyString = localStorage.getItem(key);
        if (historyString) {
          try {
            currentRolls = JSON.parse(historyString);
            foundKey = key;
            break;
          } catch (e) {
            log.warn(`Error parsing dice history from ${key}:`, e);
          }
        }
      }

      if (!currentRolls) {
        return;
      }

      try {
        // Check if we have a new roll
        if (
          !lastRolls ||
          (currentRolls[0] && JSON.stringify(currentRolls[0]) !== JSON.stringify(lastRolls[0]))
        ) {
          const newestRoll = currentRolls[0];
          if (newestRoll) {
            log.debug(
              `New roll detected in ${foundKey}:`,
              newestRoll.name,
              'with dice:',
              newestRoll.dice?.map(d => d.die)?.join(', ') || 'no dice array',
            );

            // Update participant name before processing roll
            await updateParticipantName();

            // Process the roll
            processRoll(newestRoll);
          }
          lastRolls = currentRolls;
        }
      } catch (e) {
        log.error('Error processing rolls:', e);
      }
    };

    // Set up interval for checking new rolls
    log.debug('Setting up interval for checking new rolls');
    const intervalId = setInterval(checkForNewRolls, 1000);

    // Store interval ID for potential cleanup later
    (window as any).dddiceRollCheckInterval = intervalId;

    // Mark as watching
    watchingStorage = true;
    log.debug('watchingStorage flag set to true');

    // Do an initial check
    await checkForNewRolls();

    return Promise.resolve();
  } catch (e) {
    log.error('Error setting up localStorage watch:', e);
    watchingStorage = false;
    return Promise.reject(e);
  }
}

/**
 * Send a roll request to the dddice API
 */
async function sendRollRequest(
  roll: Array<{
    type: string;
    value: number;
    theme: string | undefined;
    label?: string;
    groupSlug?: string;
  }>,
  originalRoll: DiceRoll,
  operator = {},
): Promise<void> {
  try {
    // Fetch all required theme data in parallel
    const [room, defaultTheme, hopeTheme, fearTheme, plotDieTheme] = await Promise.all([
      getStorage('room'),
      getStorage('theme'),
      getStorage('hopeTheme'),
      getStorage('fearTheme'),
      getStorage('plotDieTheme'),
    ]);

    // Validate dddice API is available
    if (!dddice?.api) {
      notify(
        `dddice extension hasn't been set up yet. Please open the extension pop up via the extensions menu`,
      );
      return;
    }

    // Validate room is selected
    if (!room?.slug) {
      notify(
        'No dddice room has been selected. Please open the dddice extension pop up and select a room to roll in',
      );
      return;
    }

    // Wait for 3D engine to be ready if it exists
    if (dddice) {
      log.debug('Waiting for 3D engine to initialize...');
      try {
        await waitForEngineReady();
      } catch (e) {
        log.error('Failed to initialize 3D engine:', e);
        notify('Failed to initialize 3D engine. Please refresh the page.');

        // Attempt to reinitialize the SDK
        initializeSDK();
        return;
      }
    }

    // Use the waitForEngineReady function defined outside this function

    // Apply themes to dice based on game system
    log.debug('Applying themes to dice');
    roll.forEach(die => {
      if (currentGameSystem === GameSystem.DAGGERHEART) {
        if (die.label === 'Hope') {
          die.theme = hopeTheme?.id;
        } else if (die.label === 'Fear') {
          die.theme = fearTheme?.id;
        } else {
          die.theme = defaultTheme?.id;
        }
      } else {
        die.theme = defaultTheme?.id;
      }
    });

    if (!defaultTheme?.id) {
      log.debug('No theme selected, using default');
    }

    // Get current game system and config
    const { system } = detectGameSystem();
    const config = gameConfigs[system];

    // Handle COSMERERPG special case with plot dice
    if (system === GameSystem.COSMERERPG) {
      log.debug('Processing COSMERERPG roll');
      const result = config.processDice(originalRoll);
      const baseLabel = config.getRollName(originalRoll);

      // Handle plot die if present
      let plotDie = null;
      if ('plotDice' in result && result.plotDice) {
        plotDie = result.plotDice;

        // Apply plot die theme if available
        plotDie.theme = plotDieTheme?.id || defaultTheme?.id;

        // Check if the selected theme supports 'setback' die type
        const themeToCheck = plotDieTheme || defaultTheme;
        if (themeToCheck) {
          // Default to d6 unless we find "setback" in available dice
          plotDie.type = 'd6';

          if (themeToCheck.available_dice && Array.isArray(themeToCheck.available_dice)) {
            const hasSetback = themeToCheck.available_dice.some(die => die.id === 'setback');
            if (hasSetback) {
              plotDie.type = 'setback';
            }
          }
        }
      }

      // Handle split rolls (attack + damage)
      const shouldSplitRoll = originalRoll.results && originalRoll.results.length > 1;

      if (shouldSplitRoll) {
        log.debug('Processing split roll (attack + damage)');

        // Filter attack dice
        const attackDice = roll.filter(
          die =>
            die.groupSlug === 'main-d20-group' ||
            (!die.groupSlug && die.groupSlug !== 'damage-group'),
        );

        // Get the original roll name without "Attack Roll: " prefix if present
        let baseLabelText = baseLabel;
        if (baseLabelText.startsWith('Attack Roll:')) {
          baseLabelText = baseLabelText.substring('Attack Roll:'.length).trim();
        }

        // Send attack roll if we have attack dice
        if (attackDice.length > 0) {
          log.debug('Sending attack dice:', attackDice);
          await dddice.api.roll.create(attackDice, {
            label: `Attack Roll: ${baseLabelText}`,
            operator,
          });
        }

        // Send damage roll if we have damage dice
        const damageDice = roll.filter(die => die.groupSlug === 'damage-group');
        if (damageDice.length > 0) {
          log.debug('Sending damage dice:', damageDice);
          await dddice.api.roll.create(damageDice, {
            label: `Damage Roll: ${baseLabelText}`,
            operator,
          });
        }

        // Send plot die if present
        if (plotDie) {
          log.debug('Sending plot die:', plotDie);
          await dddice.api.roll.create([plotDie], {
            label: `Plot Die: ${baseLabelText}${config.getTypeResult(originalRoll)}`,
          });
        }
      } else {
        // Handle non-split roll
        if (plotDie) {
          log.debug('Sending plot die and main dice separately');

          // Send main dice
          const mainDice = roll.filter(die => die.groupSlug !== 'plot-die');
          if (mainDice.length > 0) {
            log.debug('Sending main dice:', mainDice);
            await dddice.api.roll.create(mainDice, {
              label: `${baseLabel}${config.getTypeResult(originalRoll)}`,
              operator,
            });
          }

          // Send plot die
          log.debug('Sending plot die:', plotDie);
          await dddice.api.roll.create([plotDie], {
            label: `${baseLabel}${config.getTypeResult(originalRoll)}`,
          });
        } else {
          // Send all dice together
          log.debug('Sending all dice together:', roll);
          await dddice.api.roll.create(roll, {
            label: `${baseLabel}${config.getTypeResult(originalRoll)}`,
            operator,
          });
        }
      }
    } else {
      // Handle standard roll for other game systems
      log.debug('Processing standard roll for game system:', system);
      const label = config.getRollName(originalRoll) + config.getTypeResult(originalRoll);
      await dddice.api.roll.create(roll, { label: label, operator });
    }

    log.debug('Roll sent successfully');
  } catch (e: any) {
    log.error('Roll creation failed:', e);

    // Extract the most useful error message
    const errorMessage = e.response?.data?.data?.message ?? e.message ?? 'Unknown error';
    notify(`Failed to create roll: ${errorMessage}`);

    // If this appears to be a connection issue, attempt to reconnect
    if (
      errorMessage.includes('connect') ||
      errorMessage.includes('network') ||
      errorMessage.includes('timeout') ||
      e.name === 'NetworkError'
    ) {
      log.warn('Network error detected, attempting to reconnect');
      handleConnectionLost();
    }
  }
}

/**
 * Initialize the dddice SDK
 */
async function initializeSDK(): Promise<void> {
  try {
    // Reset initialization attempts if this is a fresh initialization
    if (!dddice) {
      initializationAttempts = 0;
    }

    // Increment attempts counter
    initializationAttempts++;

    // Fetch all required storage values in parallel for efficiency
    const [apiKey, room, theme, hopeTheme, fearTheme, plotDieTheme, renderMode] = await Promise.all(
      [
        getStorage('apiKey'),
        getStorage('room'),
        getStorage('theme'),
        getStorage('hopeTheme'),
        getStorage('fearTheme'),
        getStorage('plotDieTheme'),
        getStorage('render mode'),
      ],
    );

    if (!apiKey) {
      log.debug('No API key available, initialization skipped');
      return;
    }

    log.debug(
      `Initializing dddice SDK (attempt ${initializationAttempts}/${MAX_INITIALIZATION_ATTEMPTS})`,
      { renderMode },
    );

    // Clean up existing instance if present
    if (dddice) {
      log.debug('Cleaning up existing dddice instance');
      if (canvasElement) {
        canvasElement.remove();
      }
      if (dddice.api?.disconnect) {
        dddice.api.disconnect();
      }
      dddice.stop();
    }

    // Clear any existing reconnection timer
    if (reconnectionTimer) {
      clearTimeout(reconnectionTimer);
      reconnectionTimer = null;
    }

    // Initialize with 3D rendering if enabled
    if (renderMode === undefined || renderMode) {
      log.debug('Initializing with 3D rendering');

      // Create and configure canvas element
      canvasElement = document.createElement('canvas');
      canvasElement.id = 'dddice-canvas';
      canvasElement.style.cssText =
        'top:0px; position:fixed; pointer-events:none; z-index:100000; opacity:100; height:100vh; width:100vw;';
      document.body.appendChild(canvasElement);

      // Initialize ThreeDDice with canvas
      dddice = new ThreeDDice().initialize(canvasElement, apiKey, undefined, 'Demiplane');

      // Set up event handlers
      dddice.on(ThreeDDiceRollEvent.RollFinished, (roll: IRoll) => notifyRollFinished(roll));

      // Start the 3D engine
      dddice.start();

      // Connect to room if available
      if (room?.slug) {
        dddice.connect(room.slug);
      }
    } else {
      // Initialize without 3D rendering (API only)
      log.debug('Initializing API-only mode (no 3D rendering)');
      dddice = new ThreeDDice();
      dddice.api = new ThreeDDiceAPI(apiKey, 'Demiplane');

      // Connect to room if available
      if (room?.slug) {
        dddice.api.connect(room.slug);
      }

      // Set up event handlers for API mode
      dddice.api?.listen(ThreeDDiceRollEvent.RollCreated, (roll: IRoll) =>
        setTimeout(() => notifyRollCreated(roll), 1500),
      );
    }

    // Preload themes based on game system
    await preloadAllThemes(theme, hopeTheme, fearTheme, plotDieTheme);

    // Mark as initialized and store state
    isInitialized = true;
    initializationAttempts = 0; // Reset counter on successful initialization
    setStorage({ demiplane_initialized: true });

    // Set up connection monitoring using the API's built-in events
    setupConnectionMonitoring();

    // Start watching localStorage for dice rolls
    log.debug('Starting localStorage watch from initializeSDK');
    await watchLocalStorage();

    log.debug('dddice SDK initialization completed successfully');
  } catch (e: any) {
    // Handle initialization failure
    log.error('Failed to initialize dddice SDK:', e);

    const errorMessage = e.response?.data?.data?.message ?? e.message ?? 'Unknown error';
    notify(`Failed to initialize dddice: ${errorMessage}`);

    // Attempt to retry initialization if under max attempts
    if (initializationAttempts < MAX_INITIALIZATION_ATTEMPTS) {
      log.debug(
        `Retrying initialization (attempt ${initializationAttempts}/${MAX_INITIALIZATION_ATTEMPTS})`,
      );
      reconnectionTimer = setTimeout(() => {
        initializeSDK();
      }, 2000 * initializationAttempts); // Exponential backoff
    } else {
      log.error(`Failed to initialize after ${MAX_INITIALIZATION_ATTEMPTS} attempts`);
      notify('Failed to initialize dddice after multiple attempts. Please refresh the page.');
    }
  }
}

/**
 * Handle connection loss events
 */
function handleConnectionLost() {
  log.warn('dddice connection lost, attempting to reconnect');
  notify('dddice connection lost, attempting to reconnect...');

  // Attempt to reconnect after a short delay
  if (!reconnectionTimer) {
    reconnectionTimer = setTimeout(() => {
      initializeSDK();
    }, 2000);
  }
}

/**
 * Set up connection monitoring using the API's built-in events
 */
function setupConnectionMonitoring() {
  if (!dddice?.api) return;

  // Use the API's connection state change handler
  dddice.api.onConnectionStateChange((state: string) => {
    log.debug(`Connection state changed: ${state}`);
    if (state === 'disconnected' || state === 'failed') {
      handleConnectionLost();
    }
  });

  // Also handle connection errors
  dddice.api.onConnectionError((error: string) => {
    log.error(`Connection error: ${error}`);
    handleConnectionLost();
  });
}

/**
 * Preload all required themes based on game system
 */
async function preloadAllThemes(
  defaultTheme?: ITheme,
  hopeTheme?: ITheme,
  fearTheme?: ITheme,
  plotDieTheme?: ITheme,
): Promise<void> {
  try {
    // Preload default theme first
    if (defaultTheme) {
      await preloadTheme(defaultTheme);
    }

    // Preload game-specific themes
    if (currentGameSystem === GameSystem.COSMERERPG && plotDieTheme) {
      await preloadTheme(plotDieTheme);
    }

    if (currentGameSystem === GameSystem.DAGGERHEART) {
      if (hopeTheme) await preloadTheme(hopeTheme);
      if (fearTheme) await preloadTheme(fearTheme);
    }
  } catch (e) {
    log.warn('Error preloading themes:', e);
    // Continue execution even if theme preloading fails
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

/**
 * Helper function to wait for the 3D engine to be ready
 */
async function waitForEngineReady(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = 50;
    const checkInterval = 100; // ms

    const checkReady = () => {
      try {
        if (!dddice) {
          reject(new Error('dddice instance is not available'));
          return;
        }

        dddice.clear();
        resolve();
      } catch (e) {
        if (attempts >= maxAttempts) {
          reject(
            new Error(`3D engine initialization timeout after ${maxAttempts * checkInterval}ms`),
          );
        } else {
          attempts++;
          setTimeout(checkReady, checkInterval);
        }
      }
    };

    checkReady();
  });
}

/**
 * Preload a theme
 */
async function preloadTheme(theme: ITheme): Promise<void> {
  if (!theme || !dddice) {
    log.debug('Cannot preload theme: missing theme or dddice instance');
    return Promise.resolve();
  }

  try {
    log.debug('Preloading theme:', theme.name || theme.id);
    dddice.loadTheme(theme, true);
    await dddice.loadThemeResources(theme.id, true);
    log.debug(`Theme ${theme.name || theme.id} preloaded successfully`);
    return Promise.resolve();
  } catch (e) {
    log.warn(`Error preloading theme ${theme.name || theme.id}:`, e);
    // Don't reject the promise, as we want to continue even if one theme fails
    return Promise.resolve();
  }
}

async function updateParticipantName() {
  const room = await getStorage('room');
  if (!user) {
    try {
      user = (await dddice?.api?.user.get())?.data;
    } catch (e) {
      log.debug('Failed to get user', e);
      return;
    }
  }

  const { system } = detectGameSystem();
  const config = gameConfigs[system];
  const characterNameSelector = config.getCharacterNameSelector;

  if (!characterNameSelector) return;

  if (room && user) {
    const userParticipant = room.participants.find(
      ({ user: { uuid: participantUuid } }) => participantUuid === user.uuid,
    );
    const characterName = document.querySelector<HTMLElement>(characterNameSelector)?.textContent;

    log.debug('Character name:', characterName);
    log.debug('User participant:', userParticipant.username);

    if (userParticipant && userParticipant.username !== characterName) {
      userParticipant.username = characterName;
      setStorage({ room });
      await dddice?.api?.room.updateParticipant(room.slug, userParticipant.id, {
        username: characterName,
      });
      log.debug('Updated character name in room:', characterName);
    }
  }
}

/**
 * Initialize the extension
 */
async function init() {
  try {
    // Detect game system and character UUID
    const { system, uuid } = detectGameSystem();
    currentGameSystem = system;

    // Handle case when not on a character sheet page
    if (!uuid) {
      log.debug('Not on a character sheet page, cleaning up resources');
      cleanup();
      return;
    }

    log.debug(`Initializing on ${system} character sheet page with UUID: ${uuid}`);

    // Check if we need to initialize the SDK
    if (!isInitialized || !dddice?.api) {
      const initialized = await getStorage('demiplane_initialized');
      const apiKey = await getStorage('apiKey');

      log.debug('Checking initialization state:', {
        initialized,
        apiKeyExists: !!apiKey,
        isInitialized,
        hasDddiceApi: !!dddice?.api,
      });

      if (apiKey) {
        log.debug('API key found, initializing SDK');
        await initializeSDK();
      } else {
        log.debug('No API key found, skipping initialization');
      }
    } else {
      log.debug('Already initialized, updating state if needed');

      // Ensure localStorage watching is active
      if (!watchingStorage) {
        log.debug('Starting localStorage watch for dice rolls');
        await watchLocalStorage();
      }

      // Resize canvas if needed
      if (dddice?.canvas) {
        log.debug('Resizing canvas to match window dimensions');
        dddice.resize(window.innerWidth, window.innerHeight);
      }
    }
  } catch (e) {
    log.error('Error during initialization:', e);
    notify('Error initializing dddice. Please refresh the page.');
  }
}

/**
 * Clean up resources when leaving a character sheet page
 */
function cleanup() {
  // Remove canvas element if it exists
  const currentCanvas = document.getElementById('dddice-canvas');
  if (currentCanvas) {
    currentCanvas.remove();
  }

  // Clear any existing intervals
  if ((window as any).dddiceRollCheckInterval) {
    clearInterval((window as any).dddiceRollCheckInterval);
    (window as any).dddiceRollCheckInterval = null;
  }

  // No need to clean up connection monitoring as it's handled by the API

  // Clear reconnection timer
  if (reconnectionTimer) {
    clearTimeout(reconnectionTimer);
    reconnectionTimer = null;
  }

  // Reset state variables
  dddice = undefined as unknown as ThreeDDice;
  isInitialized = false;
  watchingStorage = false;
  initializationAttempts = 0;

  log.debug('Resources cleaned up');
}

// Clear dice on click, but only if not currently throwing dice
document.addEventListener('click', () => {
  if (dddice && !dddice?.isDiceThrowing) {
    try {
      dddice.clear();
    } catch (e) {
      log.warn('Error clearing dice:', e);
    }
  }
});

// Handle extension messages
chrome.runtime.onMessage.addListener(function (message) {
  log.debug('Received message:', message.type);

  switch (message.type) {
    case 'reloadDiceEngine':
      log.debug('Reloading dice engine');
      // Reset state before reinitializing
      isInitialized = false;
      watchingStorage = false;
      initializeSDK();
      init();
      break;

    case 'preloadTheme':
      log.debug('Preloading theme:', message.theme?.name || message.theme?.id);
      preloadTheme(message.theme);
      break;

    case 'connectionLost':
      log.debug('Connection lost, attempting to reconnect');
      handleConnectionLost();
      break;
  }
});

// Initialize on page load
window.addEventListener('load', () => {
  log.debug('Page loaded, initializing');
  init();
});

// Resize canvas when window size changes
window.addEventListener('resize', () => {
  if (dddice?.canvas) {
    log.debug('Window resized, updating canvas dimensions');
    dddice.resize(window.innerWidth, window.innerHeight);
  }
});

// Initialize on script load
log.debug('Script loaded, starting initialization');
init();

// Watch for URL changes to reinitialize when navigating
let lastUrl = window.location.href;
new MutationObserver(() => {
  const currentUrl = window.location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    log.debug('URL changed, reinitializing extension');
    // Reset state before reinitializing
    isInitialized = false;
    watchingStorage = false;
    init();
  }
}).observe(document, { subtree: true, childList: true });
