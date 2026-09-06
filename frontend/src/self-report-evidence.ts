// A conservative admission guard for rule-based candidates, not a semantic
// classifier. Ambiguous attribution stays in the conversation, outside memory.
export function isDirectLearnerContext(input: string): boolean {
  return !/(?:假如|假设|如果|设想|比如说|举个例子|仅供演示|测试(?:账号|帐号|数据|场景|用例)|(?:只是|这是|用于|用来|正在|做个|做一个|在做).{0,6}(?:测试|演示)|(?:替|帮).{0,8}(?:朋友|同学|学生|别人)|(?:我(?:的)?(?:朋友|同学|同事|学生|孩子)|他|她|别人|某人|某位学生)|[“”「」『』"`]|\b(?:if|suppose|hypothetical|my friend|he|she|test account)\b)/i.test(input)
}

export function evidenceClauses(input: string): string[] {
  // Retain questions: stripping punctuation must not turn them into facts.
  return (input.match(/[^，,。；;！？!?\n]+[？?]?/g) || [])
    .map(part => part.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

export function isAffirmativeEvidence(clause: string): boolean {
  return !/(?:不|没|未|无|别|尚待|还要学|想学|希望学|打算|计划|准备|可能|也许|是否|能否|吗|[？?]|\b(?:not|never|don't|haven't|want to|plan to)\b)/i.test(clause)
}

export function supportedClause(input: string, pattern: RegExp, affirmative = true): string | undefined {
  return evidenceClauses(input).find(clause => pattern.test(clause)
    && (affirmative ? isAffirmativeEvidence(clause) : !/(?:不是|并非|并不|不再|没有说|没说|不能说|可能|也许|是否|吗|[？?])/.test(clause)))
}
