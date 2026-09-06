export const PASSWORD_MIN_LENGTH = 8

export const PASSWORD_POLICY_MESSAGE = '密码至少 8 位，并包含大写字母、小写字母、数字、特殊字符中的至少两类。'

const PASSWORD_CATEGORIES = [
  /[A-Z]/,
  /[a-z]/,
  /[0-9]/,
  /[^A-Za-z0-9\s]/,
]

export function passwordPolicyError(password: string) {
  if (password.length < PASSWORD_MIN_LENGTH) return PASSWORD_POLICY_MESSAGE
  const categoryCount = PASSWORD_CATEGORIES.filter(pattern => pattern.test(password)).length
  return categoryCount >= 2 ? '' : PASSWORD_POLICY_MESSAGE
}
