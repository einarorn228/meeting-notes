import { useEffect, useState, type ReactNode } from 'react'
import type { EngineId, LlmProviderId } from '@shared/types'
import { LOCAL_MODELS } from '@shared/types'
import { api } from '@/api'
import { useI18n } from '@/i18n'
import { useRouter } from '@/router'
import { useSettings } from '@/hooks/useSettings'
import { testCapture } from '@/audio/capture'
import { Alert, Button, Field, Select, TextInput } from '@/components/ui'
import { Icon } from '@/components/Icons'
import { LevelMeter } from '@/components/LevelMeter'
import { errorMessage, mbToGb } from '@/utils/format'

const STEPS = ['welcome', 'mic', 'system', 'test', 'engine', 'llm', 'done'] as const
type Step = (typeof STEPS)[number]

export function OnboardingPage(): ReactNode {
  const { t } = useI18n()
  const { navigate } = useRouter()
  const { settings, update, save } = useSettings()
  const [step, setStep] = useState<Step>('welcome')
  const [platform, setPlatform] = useState<string>('win32')
  const [perms, setPerms] = useState<{ microphone: string; screen: string } | null>(null)
  const [levels, setLevels] = useState({ mic: 0, system: 0 })
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ mic: number; system: number; hasSystem: boolean } | null>(null)
  const [testError, setTestError] = useState<string | null>(null)

  useEffect(() => {
    api.getPlatform().then((p) => setPlatform(p.platform)).catch(() => {})
    api.getMediaPermissions().then(setPerms).catch(() => {})
  }, [step])

  const idx = STEPS.indexOf(step)
  const next = (): void => setStep(STEPS[Math.min(idx + 1, STEPS.length - 1)])
  const back = (): void => setStep(STEPS[Math.max(idx - 1, 0)])

  const requestMic = async (): Promise<void> => {
    try {
      await api.requestMicrophoneAccess()
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      s.getTracks().forEach((x) => x.stop())
    } catch {
      /* denied */
    }
    api.getMediaPermissions().then(setPerms).catch(() => {})
  }

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTestError(null)
    setTestResult(null)
    try {
      const r = await testCapture({ captureMic: true, captureSystem: true, echoCancellation: true, noiseSuppression: true, micDeviceId: settings.audio.micDeviceId, onLevels: setLevels }, 4000)
      setTestResult(r)
    } catch (err) {
      setTestError(errorMessage(err))
    } finally {
      setTesting(false)
      setLevels({ mic: 0, system: 0 })
    }
  }

  const finish = async (): Promise<void> => {
    await save({ onboardingDone: true })
    navigate({ name: 'home' })
  }

  const permLabel = (s?: string): string => t(`perm.${(s as 'granted') ?? 'unknown'}` as 'perm.granted')

  return (
    <div className="onb">
      <aside className="onb-steps">
        <div className="brand" style={{ marginBottom: 16 }}>
          <span className="brand-mark"><Icon name="mic" size={16} /></span>
          <span className="brand-name">{t('app.name')}</span>
        </div>
        {STEPS.map((s, i) => (
          <div key={s} className={`onb-step ${s === step ? 'active' : i < idx ? 'done' : ''}`}>
            <span className="onb-step-num">{i < idx ? <Icon name="check" size={12} /> : i + 1}</span>
            <span>{t(`onb.step.${s}`)}</span>
          </div>
        ))}
      </aside>
      <main className="onb-main">
        <div className="onb-card">
          {step === 'welcome' && (
            <>
              <h1>{t('onb.welcome.title')}</h1>
              <p>{t('onb.welcome.body')}</p>
              <ul className="onb-points">
                <li><Icon name="speaker" size={18} /> {t('onb.welcome.point1')}</li>
                <li><Icon name="cpu" size={18} /> {t('onb.welcome.point2')}</li>
                <li><Icon name="sparkles" size={18} /> {t('onb.welcome.point3')}</li>
              </ul>
              <Field label={t('settings.general.uiLanguage')}>
                <Select value={settings.uiLanguage} onChange={(e) => update({ uiLanguage: e.target.value as 'is' | 'en' }, { quiet: true })} style={{ width: 200 }}>
                  <option value="is">Íslenska</option>
                  <option value="en">English</option>
                </Select>
              </Field>
              <div className="onb-actions">
                <span />
                <Button variant="primary" size="lg" onClick={next}>{t('onb.welcome.start')} →</Button>
              </div>
            </>
          )}

          {step === 'mic' && (
            <>
              <h1>{t('onb.mic.title')}</h1>
              <p>{t('onb.mic.body')}</p>
              <div className="stack">
                <Alert tone={perms?.microphone === 'granted' ? 'success' : 'info'}>{t('onb.mic.status', { status: permLabel(perms?.microphone) })}</Alert>
                <div className="row gap-sm">
                  <Button variant="primary" icon="mic" onClick={requestMic}>{t('onb.mic.request')}</Button>
                  {perms?.microphone === 'denied' && <Button onClick={() => void api.openSystemPreferences('microphone')}>{t('onb.mic.openPrefs')}</Button>}
                </div>
                {perms?.microphone === 'denied' && <Alert tone="warning">{t('onb.mic.denied')}</Alert>}
              </div>
              <div className="onb-actions">
                <Button onClick={back}>{t('common.back')}</Button>
                <Button variant="primary" onClick={next}>{t('common.next')} →</Button>
              </div>
            </>
          )}

          {step === 'system' && (
            <>
              <h1>{t('onb.system.title')}</h1>
              <p>{t('onb.system.body')}</p>
              <Alert tone="info">{platform === 'win32' ? t('onb.system.windows') : platform === 'darwin' ? t('onb.system.mac') : t('onb.system.linux')}</Alert>
              {platform === 'darwin' && (
                <div className="row gap-sm">
                  <Button onClick={() => void api.openSystemPreferences('screen')}>{t('onb.system.openPrefs')}</Button>
                  <span className="muted small">{t('onb.system.permission', { status: permLabel(perms?.screen) })}</span>
                </div>
              )}
              <div className="onb-actions">
                <Button onClick={back}>{t('common.back')}</Button>
                <Button variant="primary" onClick={next}>{t('common.next')} →</Button>
              </div>
            </>
          )}

          {step === 'test' && (
            <>
              <h1>{t('onb.test.title')}</h1>
              <p>{t('onb.test.body')}</p>
              <div className="stack" style={{ marginBottom: 16 }}>
                <LevelMeter level={levels.mic} icon="mic" label={t('rec.mic')} />
                <LevelMeter level={levels.system} icon="speaker" label={t('rec.system')} />
              </div>
              <Button variant="primary" icon="record" loading={testing} onClick={runTest}>{testing ? t('onb.test.running') : t('onb.test.run')}</Button>
              <div style={{ marginTop: 14 }}>
                {testError && <Alert tone="danger">{t('onb.test.failed', { msg: testError })}</Alert>}
                {testResult && testResult.mic > 0.003 && testResult.system > 0.002 && <Alert tone="success">{t('onb.test.ok')}</Alert>}
                {testResult && testResult.mic <= 0.003 && <Alert tone="warning">{t('onb.test.noMic')}</Alert>}
                {testResult && testResult.system <= 0.002 && <Alert tone="warning">{t('onb.test.noSystem')}</Alert>}
              </div>
              <div className="onb-actions">
                <Button onClick={back}>{t('common.back')}</Button>
                <Button variant="primary" onClick={next}>{t('common.next')} →</Button>
              </div>
            </>
          )}

          {step === 'engine' && (
            <>
              <h1>{t('onb.engine.title')}</h1>
              <p>{t('onb.engine.body')}</p>
              <Field label={t('settings.general.language')}>
                <Select value={settings.language} onChange={(e) => update({ language: e.target.value }, { quiet: true })} style={{ width: 260 }}>
                  <option value="is">{t('lang.is')}</option>
                  <option value="en">{t('lang.en')}</option>
                  <option value="auto">{t('lang.auto')}</option>
                </Select>
              </Field>
              <Field label={t('settings.engine.title')}>
                <Select value={settings.engine} onChange={(e) => update({ engine: e.target.value as EngineId }, { quiet: true })} style={{ width: 320 }}>
                  <option value="local">{t('engine.local')} – {t('settings.engine.recommended')}</option>
                  <option value="azure">{t('engine.azure')}</option>
                  <option value="elevenlabs">{t('engine.elevenlabs')}</option>
                  <option value="openai">{t('engine.openai')}</option>
                </Select>
              </Field>
              {settings.engine === 'local' && (
                <Alert tone="info">
                  {t('settings.engine.local.desc')} {t('onb.engine.localNote', { model: LOCAL_MODELS[0].label, gb: mbToGb(LOCAL_MODELS[0].sizeMb) })}
                </Alert>
              )}
              {settings.engine === 'azure' && (
                <>
                  <Field label={t('settings.engine.azure.key')}><TextInput type="password" value={settings.azure.key} onChange={(e) => update({ azure: { ...settings.azure, key: e.target.value } }, { quiet: true })} /></Field>
                  <Field label={t('settings.engine.azure.region')}><TextInput value={settings.azure.region} onChange={(e) => update({ azure: { ...settings.azure, region: e.target.value } }, { quiet: true })} /></Field>
                </>
              )}
              {settings.engine === 'elevenlabs' && (
                <Field label={t('settings.engine.elevenlabs.key')}><TextInput type="password" value={settings.elevenlabs.apiKey} onChange={(e) => update({ elevenlabs: { ...settings.elevenlabs, apiKey: e.target.value } }, { quiet: true })} /></Field>
              )}
              {settings.engine === 'openai' && (
                <Field label={t('settings.engine.openai.key')}><TextInput type="password" value={settings.openaiStt.apiKey} onChange={(e) => update({ openaiStt: { ...settings.openaiStt, apiKey: e.target.value } }, { quiet: true })} /></Field>
              )}
              <div className="onb-actions">
                <Button onClick={back}>{t('common.back')}</Button>
                <Button variant="primary" onClick={next}>{t('common.next')} →</Button>
              </div>
            </>
          )}

          {step === 'llm' && (
            <>
              <h1>{t('onb.llm.title')}</h1>
              <p>{t('onb.llm.body')}</p>
              <Field label={t('settings.llm.provider')}>
                <Select value={settings.llm.provider} onChange={(e) => update({ llm: { ...settings.llm, provider: e.target.value as LlmProviderId } }, { quiet: true })} style={{ width: 300 }}>
                  <option value="anthropic">{t('settings.llm.anthropic')} – {t('settings.engine.recommended')}</option>
                  <option value="openai">{t('settings.llm.openai')}</option>
                  <option value="ollama">{t('settings.llm.ollama')}</option>
                  <option value="none">{t('settings.llm.none')}</option>
                </Select>
              </Field>
              {settings.llm.provider === 'anthropic' && (
                <Field label={t('settings.llm.anthropicKey')}><TextInput type="password" value={settings.llm.anthropicApiKey} onChange={(e) => update({ llm: { ...settings.llm, anthropicApiKey: e.target.value } }, { quiet: true })} /></Field>
              )}
              {settings.llm.provider === 'openai' && (
                <Field label={t('settings.llm.openaiKey')}><TextInput type="password" value={settings.llm.openaiApiKey} onChange={(e) => update({ llm: { ...settings.llm, openaiApiKey: e.target.value } }, { quiet: true })} /></Field>
              )}
              {settings.llm.provider === 'ollama' && (
                <Field label={t('settings.llm.ollamaModel')}><TextInput value={settings.llm.ollamaModel} onChange={(e) => update({ llm: { ...settings.llm, ollamaModel: e.target.value } }, { quiet: true })} /></Field>
              )}
              <div className="onb-actions">
                <Button onClick={back}>{t('common.back')}</Button>
                <div className="row gap-sm">
                  <Button variant="ghost" onClick={next}>{t('common.skip')}</Button>
                  <Button variant="primary" onClick={next}>{t('common.next')} →</Button>
                </div>
              </div>
            </>
          )}

          {step === 'done' && (
            <>
              <h1>{t('onb.done.title')}</h1>
              <p>{t('onb.done.body')}</p>
              <Alert tone="info">{t('onb.done.hotkey', { key: settings.hotkeys.toggleRecording })}</Alert>
              {settings.engine === 'local' && <Alert tone="info">{t('onb.done.localNote')}</Alert>}
              <div className="onb-actions">
                <Button onClick={back}>{t('common.back')}</Button>
                <Button variant="primary" size="lg" onClick={finish}>{t('onb.done.finish')}</Button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  )
}
