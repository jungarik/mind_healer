import dotenv from 'dotenv';
import { google } from 'googleapis';
import fetch from 'node-fetch';
import { Readable } from 'stream';
import { Markup, Telegraf } from 'telegraf';
dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);

const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json',
  scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets'],
});
const drive = google.drive({ version: 'v3', auth });
const sheets = google.sheets({ version: 'v4', auth });

const SPREADSHEET_ID = process.env.SHEET_ID;
const FOLDER_ID = process.env.DRIVE_FOLDER_ID;

const sessionMap = new Map(); // chatId → { lastRow, lastFileLink }

const sequenceMap = {
  1: '①', 2: '②', 3: '③', 4: '④', 5: '⑤',
  6: '⑥', 7: '⑦', 8: '⑧', 9: '⑨', 10: '⑩',
  11: '⑪', 12: '⑫', 13: '⑬', 14: '⑭', 15: '⑮',
  16: '⑯', 17: '⑰', 18: '⑱', 19: '⑲', 20: '⑳',
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
  sessionMap.set(ctx.chat.id, { lastRow: rowIndex });

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
  });

  ctx.reply('📥 Голосове отримано. Вибери категорію:', Markup.inlineKeyboard([
    [Markup.button.callback('📄 Description', 'description')],
    [Markup.button.callback('😢 Emotion', 'emotion')],
    [Markup.button.callback('💭 Thought', 'thought')],
  ]));
});

bot.action(['desc', 'emotion', 'thought'], async (ctx) => {
  const chatId = ctx.chat.id;
  const session = sessionMap.get(chatId);
  if (!session || !session.lastRow || !session.lastFileLink) {
    return ctx.reply('❗️ Немає голосового повідомлення для збереження.');
  }

  const column = getColumnLetter(category);
  const startRow = Number(session.lastRow);

  let row = startRow;
  let index = 1;

  while (true) {
    const cell = `${column}${row}`;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `Sheet1!${cell}`,
    });

    if (!res.data.values || !res.data.values.length || !res.data.values[0][0]) break;

    row++;
    index++;
    if (index > 20) break;
  }

  const symbol = sequenceMap[index] || `${index})`;
  const content = `${symbol} 🎤 ${session.lastFileLink}`;

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
  });

  ctx.editMessageText('✅ Голосове додано до категорії.');
});

bot.launch();
