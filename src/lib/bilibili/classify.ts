// “无解说类”启发式（与 scripts/coverage_probe.py 一致），供覆盖率统计口径复用，主链路不依赖。
const NON_SPEECH_KEYWORD_RE =
  /(MV|M\/V|音乐|翻唱|纯享|舞蹈|舞见|演唱|音乐会|现场版|伴奏|BGM|OST|[Ll][Ii][Vv][Ee]|dance|Dance|♪|🎵)/;

export const NON_SPEECH_MAX_DURATION = 180;

export function classifyNonSpeech(title: string, duration: number): boolean {
  if (duration <= NON_SPEECH_MAX_DURATION) return true;
  return NON_SPEECH_KEYWORD_RE.test(title ?? '');
}
