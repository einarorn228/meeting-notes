import { useEffect, useState, type ReactNode } from 'react'
import type { Correction, EngineId, LlmProviderId, Settings, SidecarStatus, SummaryTemplate } from '@shared/types'
import { LOCAL_MODELS } from '@shared/types'
import { api } from '@/api'
import { useI18n } from '@/i18n'
import { useRouter, type SettingsSection } from '@/router'
import { useEvent } from '@/hooks/useEvent'
import { useSettings } from '@/hooks/useSettings'
import { useToast } from '@/hooks/useToast'
import { listMicrophones, testCapture } from '@/audio/capture'
import { Alert, Badge, Button, Card, Field, ProgressBar, Select, TextArea, TextInput, Toggle } from '@/components/ui'
import { Icon } from '@/components/Icons'
import { LevelMeter } from '@/components/LevelMeter'
import { useUpdateStatus } from '@/components/UpdateBanner'
import { errorMessage, mbToGb } from '@/utils/format'

const SECTIONS: SettingsSection[] = ['general', 'audio', 'engine', 'llm', 'vocabulary', 'detection', 'hotkeys', 'privacy']
const APPS = ['teams', 'zoom', 'meet', 'slack', 'webex', 'discord', 'facetime']

export function SettingsPage({ section }: { section?: SettingsSection }): ReactNode {
  const { t } = useI18n()
  const { navigate } = useRouter()
  const [current, setCurrent] = useState<SettingsSection>(section ?? 'general')
  useEffect(() => {
    if (section) setCurrent(section)
  }, [section])

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t('settings.title')}</h1>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav">
          {SECTIONS.map((s) => (
            <button key={s} type="button" className={`nav-item ${current === s ? 'active' : ''}`} onClick={() => { setCurrent(s); navigate({ name: 'settings', section: s }) }}>
              {t(`settings.section.${s}`)}
            </button>
          ))}
        </nav>
        <div>
          {current === 'general' && <GeneralSection />}
          {current === 'audio' && <AudioSection />}
          {current === 'engine' && <EngineSection />}
          {current === 'llm' && <LlmSection />}
          {current === 'vocabulary' && <VocabularySection />}
          {current === 'detection' && <DetectionSection />}
          {current === 'hotkeys' && <HotkeysSection />}
          {current === 'privacy' && <PrivacySection />}
        </div>
      </div>
    </div>
  )
}

function GeneralSection(): ReactNode {
  const { t } = useI18n()
  const { settings, update } = useSettings()
  return (
    <>
      <Card title={t('settings.section.general')}>
      <Field label={t('settings.general.uiLanguage')}>
        <Select value={settings.uiLanguage} onChange={(e) => update({ uiLanguage: e.target.value as 'is' | 'en' })} style={{ width: 240 }}>
          <option value="is">Íslenska</option>
          <option value="en">English</option>
        </Select>
      </Field>
      <Field label={t('settings.general.language')} hint={t('settings.general.languageHint')}>
        <Select value={settings.language} onChange={(e) => update({ language: e.target.value })} style={{ width: 240 }}>
          <option value="is">{t('lang.is')}</option>
          <option value="en">{t('lang.en')}</option>
          <option value="auto">{t('lang.auto')}</option>
        </Select>
      </Field>
      <Toggle checked={settings.storage.keepAudio} onChange={(v) => update({ storage: { ...settings.storage, keepAudio: v } })} label={t('settings.general.keepAudio')} hint={t('settings.general.keepAudioHint')} />
      </Card>
      <UpdateSection />
    </>
  )
}

/** Version + a manual "check for updates"; the automatic path surfaces through <UpdateBanner />. */
function UpdateSection(): ReactNode {
  const { t } = useI18n()
  const status = useUpdateStatus()
  const { settings, update } = useSettings()
  const [checking, setChecking] = useState(false)
  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      await api.checkForUpdates()
    } finally {
      setChecking(false)
    }
  }
  return (
    <Card title={t('update.title')}>
      <div className="muted small">{t('update.current', { version: status?.currentVersion ?? '…' })}</div>
      <p className="muted small">{status && !status.canSelfUpdate ? t('update.manualHint') : t('update.autoHint')}</p>
      <Toggle
        checked={settings.updates.auto}
        onChange={(v) => update({ updates: { ...settings.updates, auto: v } })}
        label={t('update.auto')}
        hint={t('update.autoToggleHint')}
      />
      {status?.state === 'up-to-date' && <Alert tone="success">{t('update.upToDate')}</Alert>}
      {status?.state === 'error' && <Alert tone="danger">{t('update.error', { msg: status.message ?? '' })}</Alert>}
      <div className="row gap-sm">
        <Button size="sm" icon="refresh" loading={checking || status?.state === 'checking'} onClick={() => void check()}>
          {checking || status?.state === 'checking' ? t('update.checking') : t('update.check')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => status && void api.openExternal(status.releasesUrl)}>
          {t('update.download')}
        </Button>
      </div>
    </Card>
  )
}

function AudioSection(): ReactNode {
  const { t } = useI18n()
  const { settings, update } = useSettings()
  const [mics, setMics] = useState<{ deviceId: string; label: string }[]>([])
  const [levels, setLevels] = useState({ mic: 0, system: 0 })
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ReactNode>(null)
  useEffect(() => {
    listMicrophones().then(setMics).catch(() => setMics([]))
  }, [])
  const audio = settings.audio
  const set = (patch: Partial<Settings['audio']>): void => update({ audio: { ...audio, ...patch } })
  const run = async (): Promise<void> => {
    setTesting(true)
    setResult(null)
    try {
      const r = await testCapture({ ...audio, captureSystem: audio.captureSystemAudio, onLevels: setLevels }, 4000)
      if (r.mic > 0.003 && (r.system > 0.002 || !audio.captureSystemAudio)) setResult(<Alert tone="success">{t('settings.audio.testOk')}</Alert>)
      else if (r.mic <= 0.003) setResult(<Alert tone="warning">{t('settings.audio.testNoMic')}</Alert>)
      else setResult(<Alert tone="warning">{t('settings.audio.testNoSystem')}</Alert>)
    } catch (err) {
      setResult(<Alert tone="danger">{t('settings.audio.testFailed', { msg: errorMessage(err) })}</Alert>)
    } finally {
      setTesting(false)
      setLevels({ mic: 0, system: 0 })
    }
  }
  return (
    <Card title={t('settings.section.audio')}>
      <Field label={t('settings.audio.mic')}>
        <Select value={audio.micDeviceId} onChange={(e) => set({ micDeviceId: e.target.value })} style={{ width: 360 }}>
          <option value="default">{t('common.default')}</option>
          {mics.map((m) => (
            <option key={m.deviceId} value={m.deviceId}>{m.label}</option>
          ))}
        </Select>
        {mics.length === 0 && <div className="field-hint">{t('settings.audio.noDevices')}</div>}
      </Field>
      <Toggle checked={audio.captureSystemAudio} onChange={(v) => set({ captureSystemAudio: v })} label={t('settings.audio.captureSystem')} hint={t('settings.audio.captureSystemHint')} />
      <Toggle checked={audio.captureMic} onChange={(v) => set({ captureMic: v })} label={t('settings.audio.captureMic')} hint={t('settings.audio.captureMicHint')} />
      <Toggle checked={audio.echoCancellation} onChange={(v) => set({ echoCancellation: v })} label={t('settings.audio.echo')} />
      <Toggle checked={audio.noiseSuppression} onChange={(v) => set({ noiseSuppression: v })} label={t('settings.audio.noise')} />
      <div style={{ marginTop: 16 }} className="stack">
        <div className="muted small">{t('settings.audio.testHint')}</div>
        <LevelMeter level={levels.mic} icon="mic" label={t('rec.mic')} />
        <LevelMeter level={levels.system} icon="speaker" label={t('rec.system')} />
        <div>
          <Button variant="primary" icon="record" loading={testing} onClick={run}>{testing ? t('settings.audio.testing', { s: 4 }) : t('settings.audio.test')}</Button>
        </div>
        {result}
      </div>
    </Card>
  )
}

function EngineSection(): ReactNode {
  const { t } = useI18n()
  const { settings, update } = useSettings()
  const { toast } = useToast()
  const [sidecar, setSidecar] = useState<SidecarStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [testMsg, setTestMsg] = useState<ReactNode>(null)
  useEffect(() => {
    api.getSidecarStatus().then(setSidecar).catch(() => {})
  }, [])
  useEvent('sidecar:status', setSidecar)

  const run = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(name)
    try {
      await fn()
    } catch (err) {
      toast(t('toast.error', { msg: errorMessage(err) }), 'error')
    } finally {
      setBusy(null)
      api.getSidecarStatus().then(setSidecar).catch(() => {})
    }
  }
  const test = async (): Promise<void> => {
    setTestMsg(<span className="muted">{t('common.testing')}</span>)
    const r = await api.testEngine(settings.engine)
    setTestMsg(<Alert tone={r.ok ? 'success' : 'danger'}>{r.ok ? t('settings.engine.testOk', { msg: r.message }) : t('settings.engine.testFailed', { msg: r.message })}</Alert>)
  }
  const local = settings.local
  const setLocal = (patch: Partial<Settings['local']>): void => update({ local: { ...local, ...patch } })
  const installed = sidecar?.installedModels ?? []
  const sidecarBusy = sidecar && ['installing', 'loading-model', 'downloading-model'].includes(sidecar.state)

  const engines: { id: EngineId; badge: string }[] = [
    { id: 'local', badge: t('settings.engine.private') },
    { id: 'azure', badge: t('settings.engine.cloud') },
    { id: 'elevenlabs', badge: t('settings.engine.cloud') },
    { id: 'openai', badge: t('settings.engine.cloud') }
  ]

  return (
    <>
      <Card title={t('settings.engine.title')}>
        <p className="muted">{t('settings.engine.hint')}</p>
        <div className="engine-cards">
          {engines.map((e) => (
            <button key={e.id} type="button" className={`engine-card ${settings.engine === e.id ? 'selected' : ''}`} onClick={() => update({ engine: e.id })}>
              <div className="engine-card-title">
                <span>{t(`engine.${e.id}`)}</span>
                <span className="row gap-sm">
                  {e.id === 'local' && <Badge tone="accent">{t('settings.engine.recommended')}</Badge>}
                  <Badge tone={e.id === 'local' ? 'success' : 'neutral'}>{e.badge}</Badge>
                </span>
              </div>
              <div className="engine-card-desc">{t(`settings.engine.${e.id}.desc`)}</div>
              <div className="small">{settings.engine === e.id ? <strong className="text-accent">{t('settings.engine.selected')}</strong> : <span className="muted">{t('settings.engine.select')}</span>}</div>
            </button>
          ))}
        </div>
        <div className="row gap-sm">
          <Button onClick={test} loading={busy === 'test'}>{t('common.test')}</Button>
        </div>
        {testMsg && <div style={{ marginTop: 10 }}>{testMsg}</div>}
      </Card>

      {settings.engine === 'local' && (
        <Card title={t('engine.local')}>
          <div className="field">
            <div className="field-label">{t('settings.engine.sidecar')}</div>
            <div className="row gap-md wrap">
              <Badge tone={sidecar?.state === 'ready' ? 'success' : sidecar?.state === 'error' ? 'danger' : sidecar?.state === 'not-installed' ? 'warning' : 'info'}>
                {t(`settings.engine.sidecar.${sidecar?.state ?? 'not-installed'}`)}
              </Badge>
              <span className="muted small">{sidecar?.message}</span>
            </div>
            {sidecarBusy && <div style={{ marginTop: 8 }}><ProgressBar value={sidecar?.progress} indeterminate={sidecar?.progress === undefined} /></div>}
            <div className="row gap-sm" style={{ marginTop: 10 }}>
              {(sidecar?.state === 'not-installed' || sidecar?.state === 'error') && (
                <Button variant="primary" icon="download" loading={busy === 'install'} onClick={() => run('install', () => api.installSidecar())}>{t('settings.engine.install')}</Button>
              )}
              <Button icon="cpu" loading={busy === 'warmup'} disabled={!!sidecarBusy} onClick={() => run('warmup', () => api.warmUpLocalEngine())}>{t('settings.engine.warmup')}</Button>
            </div>
            <div className="field-hint">{t('settings.engine.installHint')}</div>
          </div>

          <div className="field">
            <div className="field-label">{t('settings.engine.model')}</div>
            <div className="model-list">
              {LOCAL_MODELS.map((m) => (
                <label key={m.id} className={`model-item ${local.modelId === m.id ? 'selected' : ''}`}>
                  <input type="radio" name="model" checked={local.modelId === m.id} onChange={() => setLocal({ modelId: m.id })} />
                  <div className="grow">
                    <div className="row gap-sm wrap">
                      <strong>{m.label}</strong>
                      {m.recommended && <Badge tone="accent">{t('settings.engine.recommended')}</Badge>}
                      <Badge>{t('settings.engine.size', { gb: mbToGb(m.sizeMb) })}</Badge>
                      <Badge tone={m.punctuated ? 'success' : 'neutral'}>{m.punctuated ? t('settings.engine.punctuatedModel') : t('settings.engine.unpunctuatedModel')}</Badge>
                      {installed.includes(m.id) && <Badge tone="success"><Icon name="check" size={11} /> {t('settings.engine.downloaded')}</Badge>}
                    </div>
                    <div className="muted small" style={{ marginTop: 4 }}>{m.description}</div>
                  </div>
                  {!installed.includes(m.id) && (
                    <Button size="sm" icon="download" loading={busy === 'dl-' + m.id} disabled={!!sidecarBusy} onClick={() => run('dl-' + m.id, () => api.downloadModel(m.id))}>{t('settings.engine.download')}</Button>
                  )}
                </label>
              ))}
            </div>
            <div className="field-hint">{t('settings.engine.modelsDir')}</div>
          </div>

          <div className="grid-2">
            <Field label={t('settings.engine.device')}>
              <Select value={local.device} onChange={(e) => setLocal({ device: e.target.value as Settings['local']['device'] })}>
                <option value="auto">{t('settings.engine.device.auto')}</option>
                <option value="cpu">{t('settings.engine.device.cpu')}</option>
                <option value="cuda">{t('settings.engine.device.cuda')}</option>
              </Select>
            </Field>
            <Field label={t('settings.engine.compute')}>
              <Select value={local.computeType} onChange={(e) => setLocal({ computeType: e.target.value as Settings['local']['computeType'] })}>
                <option value="auto">{t('settings.engine.device.auto')}</option>
                <option value="int8">int8</option>
                <option value="float16">float16</option>
                <option value="float32">float32</option>
              </Select>
            </Field>
            <Field label={t('settings.engine.threads')}>
              <TextInput type="number" min={0} max={64} value={local.threads ?? 0} onChange={(e) => setLocal({ threads: Number(e.target.value) || undefined })} />
            </Field>
            <Field label={t('settings.engine.pythonPath')} hint={t('settings.engine.pythonPathHint')}>
              <TextInput value={local.pythonPath ?? ''} onChange={(e) => setLocal({ pythonPath: e.target.value || undefined })} placeholder="python3" />
            </Field>
          </div>
          <Toggle checked={local.diarize} onChange={(v) => setLocal({ diarize: v })} label={t('settings.engine.diarize')} hint={t('settings.engine.diarizeHint')} />
          <Toggle checked={local.partials} onChange={(v) => setLocal({ partials: v })} label={t('settings.engine.partials')} hint={t('settings.engine.partialsHint')} />
        </Card>
      )}

      {settings.engine === 'azure' && (
        <Card title={t('engine.azure')}>
          <Field label={t('settings.engine.azure.key')}><TextInput type="password" value={settings.azure.key} onChange={(e) => update({ azure: { ...settings.azure, key: e.target.value } })} /></Field>
          <Field label={t('settings.engine.azure.region')}><TextInput value={settings.azure.region} placeholder="northeurope" onChange={(e) => update({ azure: { ...settings.azure, region: e.target.value } })} /></Field>
          <Toggle checked={settings.azure.diarization} onChange={(v) => update({ azure: { ...settings.azure, diarization: v } })} label={t('settings.engine.azure.diarization')} />
        </Card>
      )}
      {settings.engine === 'elevenlabs' && (
        <Card title={t('engine.elevenlabs')}>
          <Field label={t('settings.engine.elevenlabs.key')}><TextInput type="password" value={settings.elevenlabs.apiKey} onChange={(e) => update({ elevenlabs: { ...settings.elevenlabs, apiKey: e.target.value } })} /></Field>
        </Card>
      )}
      {settings.engine === 'openai' && (
        <Card title={t('engine.openai')}>
          <Field label={t('settings.engine.openai.key')}><TextInput type="password" value={settings.openaiStt.apiKey} onChange={(e) => update({ openaiStt: { ...settings.openaiStt, apiKey: e.target.value } })} /></Field>
          <Field label={t('settings.engine.openai.model')}>
            <Select value={settings.openaiStt.model} onChange={(e) => update({ openaiStt: { ...settings.openaiStt, model: e.target.value } })} style={{ width: 280 }}>
              <option value="gpt-4o-transcribe">gpt-4o-transcribe</option>
              <option value="gpt-4o-mini-transcribe">gpt-4o-mini-transcribe</option>
              <option value="whisper-1">whisper-1</option>
            </Select>
          </Field>
        </Card>
      )}
    </>
  )
}

function LlmSection(): ReactNode {
  const { t, lang } = useI18n()
  const { settings, update } = useSettings()
  const [templates, setTemplates] = useState<SummaryTemplate[]>([])
  const [testMsg, setTestMsg] = useState<ReactNode>(null)
  const [testing, setTesting] = useState(false)
  useEffect(() => {
    api.listTemplates().then(setTemplates).catch(() => {})
  }, [])
  const llm = settings.llm
  const set = (patch: Partial<Settings['llm']>): void => update({ llm: { ...llm, ...patch } })
  const test = async (): Promise<void> => {
    setTesting(true)
    try {
      const r = await api.testLlm()
      setTestMsg(<Alert tone={r.ok ? 'success' : 'danger'}>{r.ok ? t('settings.llm.testOk', { msg: r.message }) : t('settings.llm.testFailed', { msg: r.message })}</Alert>)
    } finally {
      setTesting(false)
    }
  }
  return (
    <Card title={t('settings.section.llm')}>
      <p className="muted">{t('settings.llm.hint')}</p>
      <Field label={t('settings.llm.provider')}>
        <Select value={llm.provider} onChange={(e) => set({ provider: e.target.value as LlmProviderId })} style={{ width: 300 }}>
          <option value="anthropic">{t('settings.llm.anthropic')}</option>
          <option value="openai">{t('settings.llm.openai')}</option>
          <option value="ollama">{t('settings.llm.ollama')}</option>
          <option value="none">{t('settings.llm.none')}</option>
        </Select>
      </Field>
      {llm.provider === 'anthropic' && (
        <div className="grid-2">
          <Field label={t('settings.llm.anthropicKey')}><TextInput type="password" value={llm.anthropicApiKey} onChange={(e) => set({ anthropicApiKey: e.target.value })} /></Field>
          <Field label={t('settings.llm.anthropicModel')}>
            <Select value={llm.anthropicModel} onChange={(e) => set({ anthropicModel: e.target.value })}>
              <option value="claude-opus-5">claude-opus-5 ({t('settings.engine.recommended')})</option>
              <option value="claude-fable-5-1">claude-fable-5-1</option>
              <option value="claude-sonnet-5">claude-sonnet-5</option>
            </Select>
          </Field>
        </div>
      )}
      {llm.provider === 'openai' && (
        <div className="grid-2">
          <Field label={t('settings.llm.openaiKey')}><TextInput type="password" value={llm.openaiApiKey} onChange={(e) => set({ openaiApiKey: e.target.value })} /></Field>
          <Field label={t('settings.llm.openaiModel')}><TextInput value={llm.openaiModel} onChange={(e) => set({ openaiModel: e.target.value })} /></Field>
        </div>
      )}
      {llm.provider === 'ollama' && (
        <div className="grid-2">
          <Field label={t('settings.llm.ollamaUrl')}><TextInput value={llm.ollamaUrl} onChange={(e) => set({ ollamaUrl: e.target.value })} /></Field>
          <Field label={t('settings.llm.ollamaModel')}><TextInput value={llm.ollamaModel} onChange={(e) => set({ ollamaModel: e.target.value })} placeholder="gemma4:12b" /></Field>
        </div>
      )}
      {llm.provider !== 'none' && (
        <div className="row gap-sm" style={{ marginBottom: 12 }}>
          <Button onClick={test} loading={testing}>{t('settings.llm.test')}</Button>
        </div>
      )}
      {testMsg}
      <Field label={t('settings.llm.defaultTemplate')}>
        <Select value={llm.summaryTemplateId} onChange={(e) => set({ summaryTemplateId: e.target.value })} style={{ width: 320 }}>
          {templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>{tpl.name[lang]}</option>
          ))}
        </Select>
      </Field>
      <Toggle checked={llm.autoPunctuate} onChange={(v) => set({ autoPunctuate: v })} label={t('settings.llm.autoPunctuate')} hint={t('settings.llm.autoPunctuateHint')} />
      <Toggle checked={llm.autoSummarize} onChange={(v) => set({ autoSummarize: v })} label={t('settings.llm.autoSummarize')} hint={t('settings.llm.autoSummarizeHint')} />
    </Card>
  )
}

function VocabularySection(): ReactNode {
  const { t } = useI18n()
  const { settings, update } = useSettings()
  const [text, setText] = useState(settings.vocabulary.join('\n'))
  useEffect(() => setText(settings.vocabulary.join('\n')), [settings.vocabulary])
  const [corrections, setCorrections] = useState<Correction[]>([])
  useEffect(() => {
    void api.listCorrections().then(setCorrections)
  }, [])
  return (
    <>
      <Card title={t('settings.vocab.title')}>
        <p className="muted">{t('settings.vocab.hint')}</p>
        <TextArea rows={14} value={text} placeholder={t('settings.vocab.placeholder')} onChange={(e) => setText(e.target.value)} onBlur={() => update({ vocabulary: text.split('\n').map((x) => x.trim()).filter(Boolean) })} />
        <div className="field-hint">{t('settings.vocab.count', { n: text.split('\n').filter((x) => x.trim()).length })}</div>
      </Card>
      <Card title={t('settings.corrections.title')}>
        <p className="muted">{t('settings.corrections.hint')}</p>
        {corrections.length === 0 ? (
          <div className="muted small">{t('settings.corrections.empty')}</div>
        ) : (
          <div className="stack gap-sm">
            {corrections.map((c) => (
              <div key={c.from} className="row gap-sm" style={{ alignItems: 'center' }}>
                <span style={{ flex: 1 }}>
                  „{c.from}“ → <strong>{c.to}</strong>
                </span>
                <Badge>{t('settings.corrections.times', { n: c.count })}</Badge>
                <Button size="sm" variant="ghost" icon="x" onClick={() => void api.forgetCorrection(c.from).then(setCorrections)}>
                  {t('settings.corrections.forget')}
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  )
}

function DetectionSection(): ReactNode {
  const { t } = useI18n()
  const { settings, update } = useSettings()
  const { toast } = useToast()
  const d = settings.detection
  const set = (patch: Partial<Settings['detection']>): void => update({ detection: { ...d, ...patch } })
  const [urls, setUrls] = useState(d.calendarIcsUrls.join('\n'))
  const [refreshing, setRefreshing] = useState(false)
  return (
    <Card title={t('settings.section.detection')}>
      <Toggle checked={d.enabled} onChange={(v) => set({ enabled: v })} label={t('settings.detection.enabled')} hint={t('settings.detection.enabledHint')} />
      <Field label={t('settings.detection.apps')}>
        <div className="checklist">
          {APPS.map((a) => (
            <label key={a}>
              <input type="checkbox" checked={d.apps.includes(a)} onChange={(e) => set({ apps: e.target.checked ? [...d.apps, a] : d.apps.filter((x) => x !== a) })} />
              {t(`app.${a}` as 'app.teams')}
            </label>
          ))}
        </div>
      </Field>
      <Field label={t('settings.detection.calendar')} hint={t('settings.detection.calendarHint')}>
        <TextArea rows={3} value={urls} placeholder={t('settings.detection.calendarPlaceholder')} onChange={(e) => setUrls(e.target.value)} onBlur={() => set({ calendarIcsUrls: urls.split('\n').map((x) => x.trim()).filter(Boolean) })} />
        <div className="row gap-sm" style={{ marginTop: 8 }}>
          <Button
            icon="refresh"
            loading={refreshing}
            onClick={async () => {
              setRefreshing(true)
              try {
                const ev = await api.refreshCalendar()
                toast(t('settings.detection.refreshed', { n: ev.length }), 'success')
              } catch (err) {
                toast(t('toast.error', { msg: errorMessage(err) }), 'error')
              } finally {
                setRefreshing(false)
              }
            }}
          >
            {t('settings.detection.refresh')}
          </Button>
        </div>
      </Field>
      <Field label={t('settings.detection.minutesBefore')}>
        <TextInput type="number" min={0} max={60} value={d.notifyMinutesBefore} onChange={(e) => set({ notifyMinutesBefore: Number(e.target.value) || 0 })} style={{ width: 120 }} />
      </Field>
    </Card>
  )
}

function HotkeysSection(): ReactNode {
  const { t } = useI18n()
  const { settings, update } = useSettings()
  const h = settings.hotkeys
  return (
    <Card title={t('settings.section.hotkeys')}>
      <p className="muted">{t('settings.hotkeys.hint')}</p>
      <Field label={t('settings.hotkeys.toggle')}><TextInput value={h.toggleRecording} onChange={(e) => update({ hotkeys: { ...h, toggleRecording: e.target.value } })} style={{ width: 320 }} /></Field>
      <Field label={t('settings.hotkeys.mark')}><TextInput value={h.markHighlight} onChange={(e) => update({ hotkeys: { ...h, markHighlight: e.target.value } })} style={{ width: 320 }} /></Field>
    </Card>
  )
}

function PrivacySection(): ReactNode {
  const { t } = useI18n()
  const { settings, update } = useSettings()
  const [info, setInfo] = useState<{ platform: string; version: string; dataDir: string } | null>(null)
  useEffect(() => {
    api.getPlatform().then(setInfo).catch(() => {})
  }, [])
  return (
    <Card title={t('settings.section.privacy')}>
      <Alert tone="info">{t('settings.privacy.localNote')}</Alert>
      <Field label={t('settings.privacy.consent')} hint={t('settings.privacy.consentHint')}>
        <TextArea rows={3} value={settings.consentNotice} onChange={(e) => update({ consentNotice: e.target.value })} />
      </Field>
      <Field label={t('settings.privacy.dataDir')}>
        <div className="row gap-sm">
          <code className="mono small">{info?.dataDir ?? '…'}</code>
          <Button size="sm" icon="folder" onClick={() => info && void api.openPath(info.dataDir)}>{t('settings.privacy.openFolder')}</Button>
        </div>
      </Field>
      <div className="muted small">{t('settings.privacy.platform')}: {info?.platform} · Fundarritari {info?.version}</div>
    </Card>
  )
}
