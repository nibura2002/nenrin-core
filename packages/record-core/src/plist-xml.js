// XML 形式の plist を素の JS 値に読む最小パーサ(依存なし)。
// バイナリ plist は mac の `plutil -convert xml1 -o - -` で XML にしてから渡す(adapters/logic.js)。
// 対応: dict / array / string / integer / real / true / false / date / data(base64 文字列のまま)。
const ENT = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
const unesc = (s) => s.replace(/&(lt|gt|amp|quot|apos);/g, (m) => ENT[m]);

export function parsePlistXml(xml) {
  const tokens = [...xml.matchAll(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>|([^<]+)/g)];
  let i = 0;
  // 値の前にあるテキスト(空白、および <?xml ?> / <!DOCTYPE> のようにタグとして取れなかった断片)を飛ばす
  const skipWs = () => { while (i < tokens.length && tokens[i][5] != null) i++; };
  function text(tag) {
    let s = '';
    while (i < tokens.length && !(tokens[i][1] === '/' && tokens[i][2] === tag)) { if (tokens[i][5] != null) s += tokens[i][5]; i++; }
    i++; // closing tag
    return unesc(s);
  }
  function value() {
    skipWs();
    const t = tokens[i];
    if (!t || t[1] === '/') return undefined;
    const tag = t[2]; const selfClosing = t[4] === '/';
    i++;
    switch (tag) {
      case 'true': return true;
      case 'false': return false;
      case 'string': return selfClosing ? '' : text('string');
      case 'date': return selfClosing ? '' : text('date');
      case 'data': return selfClosing ? '' : text('data').replace(/\s+/g, '');
      case 'integer': return selfClosing ? 0 : Number(text('integer'));
      case 'real': return selfClosing ? 0 : Number(text('real'));
      case 'array': {
        const out = [];
        if (selfClosing) return out;
        for (;;) { skipWs(); if (tokens[i]?.[1] === '/' && tokens[i]?.[2] === 'array') { i++; return out; } out.push(value()); }
      }
      case 'dict': {
        const out = {};
        if (selfClosing) return out;
        for (;;) {
          skipWs();
          if (tokens[i]?.[1] === '/' && tokens[i]?.[2] === 'dict') { i++; return out; }
          if (tokens[i]?.[2] !== 'key') { i++; continue; }
          i++; const k = text('key'); out[k] = value();
        }
      }
      case 'plist': return value();
      default: { if (!selfClosing) text(tag); return undefined; }
    }
  }
  return value();
}
