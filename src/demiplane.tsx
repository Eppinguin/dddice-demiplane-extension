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
  return lastSourceElement?.textContent && lastNameElement?.textContent
    ? `${lastSourceElement.textContent}: ${lastNameElement.textContent}`
    : '';
}
function getTypeResult(): string {
  const historyElement = document.querySelector('.dice-roller-history--0');

  if (historyElement) {
    const hasFear = historyElement.classList.contains('dice-roller-history--roll-with-fear');
    const hasHope = historyElement.classList.contains('dice-roller-history--roll-with-hope');
    const hasCriticalSuccess = historyElement.classList.contains(
      'dice-roller-history--critical-success',
    );

    if (hasFear) return ' with Fear';
    if (hasHope) return ' with Hope';
    if (hasCriticalSuccess) return ' Critical Success!';
  }
  return '';
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
    const diceContainer = document.querySelector<HTMLElement>(
      '.dice-history-roll-result-container',
    );
    if (!diceContainer) return;

    const diceArray: Array<{
      type: string;
      value: number;
      theme: string | undefined;
      label?: string;
    }> = [];
    const diceElements = diceContainer.querySelectorAll<HTMLElement>('.history-item-result__die');

    diceElements.forEach(diceElement => {
      const valueElement = diceElement.querySelector<HTMLElement>('.history-item-result__label');
      const value = valueElement ? parseInt(valueElement.textContent || '0', 10) : 0;
      const label = diceElement.querySelector<HTMLImageElement>('img')?.alt || '';
      const typeClass = Array.from(diceElement.classList).find(cls =>
        cls.startsWith('history-item-result__die--'),
      );
      const type = (() => {
        if (label === 'Hope' || label === 'Fear') return 'd12';
        if (label === 'Advantage' || label === 'Disadvantage') return 'd6';
        return typeClass ? typeClass.split('--')[1] : 'unknown';
      })();

      diceArray.push({
        type: label === 'Disadvantage' ? 'mod' : type,
        value: label === 'Disadvantage' ? -value : value,
        theme: label === 'Hope' ? hopeThemeId : label === 'Fear' ? fearThemeId : theme.id,
        label: label,
      });
    });

    const modifierElement = diceContainer.querySelector<HTMLElement>(
      '.dice-history-item-static-modifier',
    );
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
      }
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

async function sendRollRequest(
  roll: Array<{ type: string; value: number; theme: string | undefined; label?: string }>,
): Promise<void> {
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
      const label = getRollName() + getTypeResult();
      await dddice.api.roll.create(roll, { label: label });
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

    if (renderMode === undefined || renderMode) {
      canvasElement = document.createElement('canvas');
      canvasElement.id = 'dddice-canvas';
      canvasElement.style.cssText =
        'top:0px; position:fixed; pointer-events:none; z-index:100000; opacity:100; height:100vh; width:100vw;';
      document.body.appendChild(canvasElement);
      try {
        dddice = new ThreeDDice().initialize(canvasElement, apiKey, undefined, 'Demiplane');
        dddice.on(ThreeDDiceRollEvent.RollFinished, (roll: IRoll) => notifyRollFinished(roll));
        dddice.start();
        if (room) dddice.connect(room.slug);
      } catch (e: any) {
        console.error(e);
        notify(`${e.response?.data?.data?.message ?? e}`);
      }
      if (theme) preloadTheme(theme);
    } else {
      try {
        dddice = new ThreeDDice();
        dddice.api = new ThreeDDiceAPI(apiKey, 'Demiplane');
        if (room) dddice.api.connect(room.slug);
      } catch (e: any) {
        console.error(e);
        notify(`${e.response?.data?.data?.message ?? e}`);
      }
      dddice.api?.listen(ThreeDDiceRollEvent.RollCreated, (roll: IRoll) =>
        setTimeout(() => notifyRollCreated(roll), 1500),
      );
    }
  });
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

function preloadTheme(theme: ITheme): void {
  dddice.loadTheme(theme, true);
  dddice.loadThemeResources(theme.id, true);
}

async function init() {
  if (!/^\/(nexus\/daggerheart\/character-sheet\/.+)/.test(window.location.pathname)) {
    log.debug('uninit');
    const currentCanvas = document.getElementById('dddice-canvas');
    if (currentCanvas) {
      currentCanvas.remove();
      dddice = undefined as unknown as ThreeDDice;
    }
    return;
  }
  log.debug('init');

  const rollButton = document.querySelector('.dice-roll-button');
  if (!rollButton) return;
  rollButton.addEventListener('click', handleRollButtonClick, true);

  // add canvas element to document
  const renderMode = await getStorage('render mode');
  if (!document.getElementById('dddice-canvas') && renderMode) {
    await initializeSDK();
  }

  const room = await getStorage('room');
  if (!user) {
    user = (await dddice?.api?.user.get())?.data;
  }
  const characterName = document.querySelector<HTMLElement>(
    '.MuiGrid-root.MuiGrid-item.text-block.character-name.css-1ipveys .text-block__text.MuiBox-root.css-1dyfylb',
  )?.textContent;

  const userParticipant = room?.participants.find(
    ({ user: { uuid: participantUuid } }) => participantUuid === user.uuid,
  );

  if (characterName && userParticipant?.username != characterName) {
    userParticipant.username = characterName;
    setStorage({ room });
    await dddice?.api?.room.updateParticipant(room.slug, userParticipant.id, {
      username: characterName,
    });
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
  }
});

// window.addEventListener('load', () => init());
window.addEventListener('resize', () => init());

const observer = new MutationObserver(() => {
  const diceRollerOpen = document.querySelector('.dice-roller--open');
  if (diceRollerOpen) {
    init();
    observer.observe(diceRollerOpen, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  }
});

window.addEventListener('load', () => {
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
});
