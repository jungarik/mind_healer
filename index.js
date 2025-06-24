
import { SpeechClient } from '@google-cloud/speech';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import fetch from 'node-fetch';
import { Readable } from 'stream';
import { Markup, Telegraf } from 'telegraf';
dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);

const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json',
  scopes: [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/cloud-platform'
  ],
});
const drive = google.drive({ version: 'v3', auth });
const sheets = google.sheets({ version: 'v4', auth });
const speechClient = new SpeechClient();

const SPREADSHEET_ID = process.env.SHEET_ID;
const FOLDER_ID = process.env.DRIVE_FOLDER_ID;

const sessionMap = new Map(); // chatId → { lastRow, lastFileLink, buffer }

const sequenceMap = {
  1: '①', 2: '②', 3: '③', 4: '④', 5: '⑤',
  6: '⑥', 7: '⑦', 8: '⑧', 9: '⑨', 10: '⑩',
  11: '⑪', 12: '⑫', 13: '⑬', 14: '⑭', 15: '⑮',
  16: '⑯', 17: '⑰', 18: '⑱', 19: '⑲', 20: '⑳',
};

const buttonMap = {
  description: '📄 Ситуація',
  emotion: '😢 Емоція',
  thought: '💭 Думка',
};

function getColumnLetter(category) {
  return {
    description: 'B',
    emotion: 'C',
    thought: 'D',
  }[category];
}

async function uploadToDrive(buffer, filename) {
  const fileMetadata = { name: filename, parents: [FOLDER_ID] };
  const media = {
    mimeType: 'audio/ogg',
    body: Readable.from(buffer)
  };

  const res = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: 'id',
  });

  return `https://drive.google.com/file/d/${res.data.id}/view`;
}

async function transcribeAudio(buffer) {
  if (buffer.length > 1024 * 1024) {
    console.warn('⚠️ Audio buffer too large for recognize');
    return '⚠️ Аудіо надто велике для розпізнавання';
  }

  const audioBytes = buffer.toString('base64');
  const request = {
    audio: { content: audioBytes },
    config: {
      encoding: 'OGG_OPUS',
      sampleRateHertz: 48000,
      languageCode: 'uk-UA',
      alternativeLanguageCodes: ['ru-RU'],
      enableAutomaticPunctuation: true,
      model: 'default'
    }
  };

  try {
    const [response] = await speechClient.recognize(request);
    const transcription = response.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');
    return transcription || '';
  } catch (err) {
    console.error('❌ Speech-to-Text error:', err.message);
    return '⚠️ Неможливо розпізнати голосове';
  }
}

bot.start((ctx) =>
  ctx.reply('Привіт! Натисни кнопку, щоб створити новий запис.', Markup.keyboard([['➕ New Entry']]).resize())
);

bot.hears('➕ New Entry', async (ctx) => {
  const date = new Date().toISOString();
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Sheet1!A:D',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[date, '', '', '']],
    },
  });
  const rowIndex = res.data.updates.updatedRange.match(/\d+$/)[0];
  sessionMap.set(ctx.chat.id, { lastRow: rowIndex, currentVoiceIndex: 1 });

  ctx.reply('🔄 Новий запис створено! Надішли голосове, а потім вибери категорію.');
});

bot.on('voice', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!sessionMap.has(chatId)) {
    return ctx.reply('❗️ Спочатку натисни "➕ New Entry", щоб створити новий запис.');
  }

  const file = await ctx.telegram.getFile(ctx.message.voice.file_id);
  const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(fileUrl);
  const buffer = await response.buffer();

  const filename = `voice-${Date.now()}.ogg`;
  const driveLink = await uploadToDrive(buffer, filename);

  sessionMap.set(chatId, {
    ...sessionMap.get(chatId),
    lastFileLink: driveLink,
    buffer,
  });

  ctx.reply('📥 Голосове отримано. Вибери категорію:', Markup.inlineKeyboard([
    [Markup.button.callback(buttonMap.description, 'description')],
    [Markup.button.callback(buttonMap.emotion, 'emotion')],
    [Markup.button.callback(buttonMap.thought, 'thought')],
  ]));
});

bot.action(['description', 'emotion', 'thought'], async (ctx) => {
  const chatId = ctx.chat.id;
  const session = sessionMap.get(chatId);
  if (!session || !session.lastRow || !session.lastFileLink || !session.buffer) {
    return ctx.reply('❗️ Немає голосового повідомлення для збереження.');
  }

  const category = ctx.match[0];
  const transcription = await transcribeAudio(session.buffer);
  const column = getColumnLetter(category);
  const startRow = Number(session.lastRow);
  const index = session.currentVoiceIndex;

  let row = startRow;

  while (true) {
    const cell = `${column}${row}`;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `Sheet1!${cell}`,
    });

    if (!res.data.values || !res.data.values.length || !res.data.values[0][0]) break;

    row++;
  }

  const symbol = sequenceMap[index] || `${index})`;
  const text = transcription ? `[${transcription}]` : '';
  const content = `[${symbol}][${session.lastFileLink}]${text}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Sheet1!${column}${row}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[content]],
    },
  });

  sessionMap.set(chatId, {
    lastRow: session.lastRow,
    currentVoiceIndex: index + 1,
  });

  ctx.editMessageText(`✅ Голосове додано до категорії: ${buttonMap[category]}`);
});

bot.launch();
