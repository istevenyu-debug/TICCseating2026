/** 給後台複製的 Apps Script（裝在 Google 表單裡） */
export function appsScript(url: string) {
  return `// 劃位系統：把這份表單的回覆送到後台「四、表單／收款」
// 第一次：選上方函式「install」→ 按「執行」→ 依畫面允許權限。之後不用再動。
const TICC_URL = '${url}';

function syncNow() {
  const list = FormApp.getActiveForm().getResponses().map(function (r) {
    return {
      id: r.getId(), at: r.getTimestamp().toISOString(), email: r.getRespondentEmail() || '',
      answers: r.getItemResponses().map(function (i) {
        const v = i.getResponse();
        return { q: i.getItem().getTitle(), a: Array.isArray(v) ? v.join('、') : String(v) };
      }),
    };
  });
  for (let i = 0; i < list.length; i += 100) {
    const res = UrlFetchApp.fetch(TICC_URL, { method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ list: list.slice(i, i + 100) }), muteHttpExceptions: true });
    Logger.log(res.getResponseCode() + ' ' + res.getContentText());
  }
}

function install() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncNow').forForm(FormApp.getActiveForm()).onFormSubmit().create();
  ScriptApp.newTrigger('syncNow').timeBased().everyMinutes(5).create();
  syncNow();
}
`;
}
