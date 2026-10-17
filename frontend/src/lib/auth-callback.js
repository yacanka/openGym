// token_hash email links also work on a different device; Google uses PKCE.
export async function handleAuthCallback(auth, href, clean) {
  const url = new URL(href)
  const p = url.searchParams
  if (!['code', 'token_hash', 'error', 'error_description'].some((key) => p.has(key)))
    return { handled: false, recovery: false }
  try {
    if (p.has('error')) throw new Error(p.get('error_description') || 'Sign-in was cancelled')
    let result
    if (p.has('code')) result = await auth.exchangeCodeForSession(p.get('code'))
    else if (
      p.has('token_hash') &&
      ['email', 'signup', 'recovery', 'email_change', 'invite'].includes(p.get('type'))
    ) {
      result = await auth.verifyOtp({ token_hash: p.get('token_hash'), type: p.get('type') })
    } else throw new Error('Invalid sign-in link')
    if (result.error) throw result.error
    return { handled: true, recovery: p.get('type') === 'recovery' || p.get('flow') === 'recovery' }
  } finally {
    clean(url.pathname + (url.hash.startsWith('#/') ? url.hash : '#/home'))
  }
}
