/** @format */
import createLogger from './log';
import { getStorage, setStorage } from './storage';
import { IRoll, ThreeDDiceRollEvent, ThreeDDice, ITheme, ThreeDDiceAPI, IUser } from 'dddice-js';
import notify from './utils/notify';
import { Notify } from 'notiflix/build/notiflix-notify-aio';

Notify.init({
  useIcon: false,
  fontSize: '16px',
  timeout: 10000,
  clickToClose: true,
});

const log = createLogger('demiplane');
log.info('DDDICE Demiplane');

let dddice: ThreeDDice;
let canvasElement: HTMLCanvasElement;
let user: IUser;

function getRollName(): string {
  const sourceElements = document.querySelectorAll<HTMLElement>('.dice-history-item-name--source');
  const nameElements = document.querySelectorAll<HTMLElement>('.dice-history-item-name');
  const lastSourceElement = sourceElements[sourceElements.length - 1];
  const lastNameElement = nameElements[nameElements.length - 1];
  if (lastSourceElement?.textContent && lastNameElement?.textContent) {
    return `${lastSourceElement.textContent}: ${lastNameElement.textContent}`;
  } else {
    return "";
  }
}

async function handleRollButtonClick(): Promise<void> {
  const parsedResults = new Set<string>();
  const [theme, hopeTheme, fearTheme] = await Promise.all([
    getStorage('theme'),
    getStorage('hopeTheme'),
    getStorage('fearTheme'),
  ]);

  const hopeThemeId = hopeTheme ? hopeTheme.id : null;
  const fearThemeId = fearTheme ? fearTheme.id : null;

  function parseDiceValues(): void {
    const diceContainer = document.querySelector<HTMLElement>('.dice-history-roll-result-container');
    if (!diceContainer) {
      return;
    }

    const diceArray: Array<{ type: string; value: number; theme: string | null; label?: string }> = [];
    const diceElements = diceContainer.querySelectorAll<HTMLElement>('.history-item-result__die');

    diceElements.forEach(diceElement => {
      const valueElement = diceElement.querySelector<HTMLElement>('.history-item-result__label');
      const value = valueElement ? parseInt(valueElement.textContent || '0', 10) : 0;
      const label = diceElement.querySelector<HTMLImageElement>('img')?.alt || '';
      const typeClass = Array.from(diceElement.classList).find(cls =>
        cls.startsWith('history-item-result__die--'),
      );
      const type = (() => {
        if (label === 'Hope' || label === 'Fear') {
          return 'd12';
        } else if (label === 'Advantage' || label === 'Disadvantage') {
          return 'd6';
        } else {
          return typeClass ? typeClass.split('--')[1] : 'unknown';
        }
      })();

      diceArray.push({
        type: label === 'Disadvantage' ? 'mod' : type,
        value: label === 'Disadvantage' ? -value : value,
        theme: label === 'Hope' ? hopeThemeId : label === 'Fear' ? fearThemeId : theme.id,
        label: label,
      });
    });

    const modifierElement = diceContainer.querySelector<HTMLElement>('.dice-history-item-static-modifier');
    if (modifierElement) {
      const modifierValue = parseInt(modifierElement.textContent?.replace('+', '') || '0', 10);
      if (modifierValue !== 0) {
        diceArray.push({
          type: 'mod',
          theme: theme.id,
          value: modifierValue,
        });
      }
    }

    const resultString = JSON.stringify(diceArray);
    if (!parsedResults.has(resultString)) {
      sendRollRequest(diceArray);
      parsedResults.add(resultString);
    }

    observer.disconnect();
  }

  const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      if (mutation.addedNodes.length) {
        parseDiceValues();
        getRollName();
      }
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

const observer = new MutationObserver(mutations => {
  mutations.forEach(mutation => {
    mutation.addedNodes.forEach(node => {
      if (node instanceof HTMLElement && node.querySelector('.dice-roll-button--roll')) {
        const rollButton = node.querySelector<HTMLButtonElement>('.dice-roll-button--roll');
        if (rollButton) {
          rollButton.addEventListener('click', handleRollButtonClick);
        }
      }
    });
  });
});

observer.observe(document.body, { childList: true, subtree: true });

async function sendRollRequest(roll: Array<{ type: string; value: number; theme: string | null; label?: string }>): Promise<void> {
  const [room] = await Promise.all([getStorage('room')]);

  if (!dddice?.api) {
    notify(
      `dddice extension hasn't been set up yet. Please open the the extension pop up via the extensions menu`,
    );
  } else if (!room?.slug) {
    notify(
      'No dddice room has been selected. Please open the dddice extension pop up and select a room to roll in',
    );
  } else {
    try {
      await updateUsername();
      const label = getRollName();
      await dddice.api.roll.create(roll, { label: label });
    } catch (e: any) {
      console.error(e);
      notify(`${e.response?.data?.data?.message ?? e}`);
    }
  }
}

async function updateUsername(): Promise<void> {
  const [room] = await Promise.all([getStorage('room')]);
  if (!dddice?.api) {
    notify(
      `dddice extension hasn't been set up yet. Please open the the extension pop up via the extensions menu`,
    );
  } else if (!room?.slug) {
    notify(
      'No dddice room has been selected. Please open the dddice extension pop up and select a room to roll in',
    );
  } else {
    try {
      const characterNameElement = document.querySelector<HTMLElement>(
        '.MuiGrid-root.MuiGrid-item.text-block.character-name.css-1ipveys .text-block__text.MuiBox-root.css-1dyfylb',
      );
      const characterName = characterNameElement ? characterNameElement.textContent : null;
      if (!user) {
        user = (await dddice.api.user.get()).data;
      }
      const userParticipant = room.participants.find(
        ({ user: { uuid: participantUuid } }) => participantUuid === user.uuid,
      );
      if (characterName && userParticipant.username !== characterName) {
        userParticipant.username = characterName;
        setStorage({ room });
        await dddice.api.room.updateParticipant(room.slug, userParticipant.id, {
          username: characterName,
        });
      }
    } catch (e: any) {
      console.error(e);
      notify(`${e.response?.data?.data?.message ?? e}`);
    }
  }
}

async function initializeSDK(): Promise<void> {
  return Promise.all([
    getStorage('apiKey'),
    getStorage('room'),
    getStorage('theme'),
    getStorage('render mode'),
  ]).then(async ([apiKey, room, theme, renderMode]) => {
    if (apiKey) {
      log.debug('initializeSDK', renderMode);
      if (dddice) {
        if (canvasElement) canvasElement.remove();
        if (dddice.api?.isConnected()) dddice.api.disconnect();
        dddice.stop();
      }
      if (renderMode === undefined || renderMode) {
        canvasElement = document.createElement('canvas');
        canvasElement.id = 'dddice-canvas';
        canvasElement.style.top = '0px';
        canvasElement.style.position = 'fixed';
        canvasElement.style.pointerEvents = 'none';
        canvasElement.style.zIndex = '100000';
        canvasElement.style.opacity = '100';
        canvasElement.style.height = '100vh';
        canvasElement.style.width = '100vw';
        document.body.appendChild(canvasElement);
        try {
          dddice = new ThreeDDice().initialize(canvasElement, apiKey, undefined, 'Demiplane');
          dddice.start();
          if (room) {
            dddice.connect(room.slug);
          }
        } catch (e: any) {
          console.error(e);
          notify(`${e.response?.data?.data?.message ?? e}`);
        }
        if (theme) {
          preloadTheme(theme);
        }
      } else {
        try {
          dddice = new ThreeDDice();
          dddice.api = new ThreeDDiceAPI(apiKey, 'Demiplane');
          if (room) {
            dddice.api.connect(room.slug);
          }
        } catch (e: any) {
          console.error(e);
          notify(`${e.response?.data?.data?.message ?? e}`);
        }
      }
    } else {
      log.debug('no api key');
    }
  });
}

function preloadTheme(theme: ITheme): void {
  dddice.loadTheme(theme, true);
  dddice.loadThemeResources(theme.id, true);
}

initializeSDK();

document.addEventListener('DOMContentLoaded', initializeSDK);
window.addEventListener('storage', (event: StorageEvent) => {
  if (event.key === 'theme' || event.key === 'render mode') {
    initializeSDK();
  }
});