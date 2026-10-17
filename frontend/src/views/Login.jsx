import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { DEMO } from '../lib/demo.js'
import { supabase } from '../lib/supabase.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { AuthForm } from '../components/Account.jsx'

export default function Login() {
  const {setGuest,accountError}=useStore()
  return <main className="narrow auth-gate">
    <div style={{fontSize:54,color:'var(--acc)',display:'flex',justifyContent:'center'}}><Icon name="dumbbell"/></div>
    <h1 style={{textAlign:'center'}}>openGym</h1>
    <p className="muted" style={{textAlign:'center'}}>{t(DEMO?'Live demo — everything stays in this browser.':'Your workouts. Your weights. Your profile.')}</p>
    {!DEMO&&<>
      {accountError&&<p role="alert" className="auth-error">{supabase?accountError:t('Cloud sync has not been configured. You can still train in guest mode.')}</p>}
      <AuthForm/>
    </>}
    <Button variant="ghost" onClick={()=>setGuest(true)}>{t(DEMO?'Start the demo':'Continue without account')}</Button>
  </main>
}
