<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import AccountSettingsCard from '@/components/settings/AccountSettingsCard.vue'
import AccountSettingsDialog from '@/components/settings/AccountSettingsDialog.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'

/** 账号在线配置：周期性重登已整体下线，只保留掉线重登。 */
interface OnlineConfig {
  offlineEnabled: boolean
  offlineDelaySeconds: number
}

const emit = defineEmits<{ notify: [message: string, type?: 'primary' | 'danger'] }>()

const DEFAULT_CONFIG: OnlineConfig = { offlineEnabled: true, offlineDelaySeconds: 60 }

const config = ref<OnlineConfig>({ ...DEFAULT_CONFIG })
const draft = ref<OnlineConfig>({ ...DEFAULT_CONFIG })
// 服务启动后自动登录已保存的账号（系统级开关，默认开启）。
const autoStart = ref(true)
const loading = ref(true)
const saving = ref(false)
const open = ref(false)

const busy = computed(() => saving.value)
const disabled = computed(() => loading.value || busy.value)
const enabled = computed(() => config.value.offlineEnabled || autoStart.value)
const status = computed(() => loading.value ? '加载中' : enabled.value ? '已开启' : '已关闭')
const tags = computed(() => [
  autoStart.value ? '服务启动自动登录 已开启' : '服务启动自动登录 已关闭',
  config.value.offlineEnabled ? `掉线后 ${config.value.offlineDelaySeconds} 秒重登` : '掉线重登关闭',
  '微信授权到期前自动续期 常开',
])

function normalize(input: any): OnlineConfig {
  const src = (input && typeof input === 'object') ? input : {}
  const delay = Number(src.offlineDelaySeconds)
  return {
    offlineEnabled: src.offlineEnabled === undefined || src.offlineEnabled === null
      ? true
      : src.offlineEnabled === true,
    offlineDelaySeconds: Number.isFinite(delay) ? Math.max(1, Math.min(86400, Math.round(delay))) : DEFAULT_CONFIG.offlineDelaySeconds,
  }
}

async function load() {
  loading.value = true
  try {
    const { data } = await api.get('/api/settings/system-config')
    if (data?.ok) {
      const saved = data.data?.saved || data.data?.default
      config.value = normalize(saved?.autoCodeRefresh)
      autoStart.value = saved?.autoStartAccounts !== false
    }
  }
  catch (e) {
    console.error('加载账号在线配置失败:', e)
  }
  finally {
    loading.value = false
  }
}

async function save(next: OnlineConfig) {
  if (disabled.value)
    return false
  saving.value = true
  try {
    const payload = normalize(next)
    const { data } = await api.post('/api/settings/system-config', { autoCodeRefresh: payload })
    if (!data?.ok) {
      emit('notify', getApiErrorMessage(data, '保存账号在线配置失败'), 'danger')
      return false
    }
    config.value = normalize((data.data?.saved || payload)?.autoCodeRefresh)
    emit('notify', '账号在线配置已保存', 'primary')
    return true
  }
  catch (e: any) {
    emit('notify', `保存失败: ${getApiErrorMessage(e, '未知错误')}`, 'danger')
    return false
  }
  finally {
    saving.value = false
  }
}

async function submit() {
  const saved = await save(draft.value)
  if (saved)
    open.value = false
}

function configure() {
  draft.value = { ...config.value }
  open.value = true
}

function toggleOffline(next: boolean | undefined) {
  void save({ ...config.value, offlineEnabled: !!next })
}

async function saveAutoStart(next: boolean | undefined) {
  if (disabled.value)
    return
  const nextValue = !!next
  saving.value = true
  try {
    const { data } = await api.post('/api/settings/system-config', { autoStartAccounts: nextValue })
    if (!data?.ok) {
      emit('notify', getApiErrorMessage(data, '保存自动登录设置失败'), 'danger')
      return
    }
    autoStart.value = (data.data?.saved?.autoStartAccounts ?? nextValue) !== false
    emit('notify', autoStart.value ? '已开启服务启动自动登录' : '已关闭服务启动自动登录', 'primary')
  }
  catch (e: any) {
    emit('notify', `保存失败: ${getApiErrorMessage(e, '未知错误')}`, 'danger')
  }
  finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center justify-between gap-3">
      <div>
        <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
          账号登录与重连
        </h4>
        <p class="mt-0.5 text-xs text-gray-500">
          服务启动自动登录、掉线自动重登与微信授权到期前续期
        </p>
      </div>
    </div>
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <AccountSettingsCard
        title="账号登录与重连"
        description="所有账号共享 · 启动登录、掉线恢复与到期续期"
        icon="i-carbon-renew"
        :enabled="enabled"
        :disabled="disabled"
        :status="status"
        :tags="tags"
        hide-switch
        @configure="configure"
      >
        <template #extra>
          <div class="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-3 md:flex-col md:items-start md:gap-2 dark:border-gray-700">
            <div class="min-w-0">
              <h5 class="text-xs text-gray-900 font-semibold dark:text-gray-100">
                服务启动自动登录
              </h5>
              <p class="mt-0.5 text-xs text-gray-500 leading-relaxed">
                重启服务后自动拉起已保存账号；QQ 账号 Code 失效仍需重新扫码或填写新 Code
              </p>
            </div>
            <BaseSwitch
              :model-value="autoStart"
              label="自动登录"
              :disabled="disabled"
              @update:model-value="saveAutoStart"
            />
          </div>
          <div class="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-3 md:flex-col md:items-start md:gap-2 dark:border-gray-700">
            <div class="min-w-0">
              <h5 class="text-xs text-gray-900 font-semibold dark:text-gray-100">
                掉线自动重登
              </h5>
              <p class="mt-0.5 text-xs text-gray-500 leading-relaxed">
                账号断开或被踢下线后，自动续期微信授权并重新登录
              </p>
            </div>
            <BaseSwitch
              :model-value="config.offlineEnabled"
              label="掉线重登"
              :disabled="disabled"
              @update:model-value="toggleOffline"
            />
          </div>
        </template>
      </AccountSettingsCard>
    </div>

    <AccountSettingsDialog
      v-if="open"
      title="账号登录与重连"
      description="所有微信区账号共享 · 仅对具备微信登录凭据的账号生效"
      icon="i-carbon-renew"
      :saving="busy"
      :disabled="disabled"
      @cancel="!busy && (open = false)"
      @save="submit"
    >
      <div class="space-y-4">
        <BaseInput
          v-model.number="draft.offlineDelaySeconds"
          label="掉线后等待（秒）"
          type="number"
          min="1"
          max="86400"
          placeholder="60"
          :disabled="busy"
        />
        <p class="text-xs text-gray-500">
          掉线重登会在账号停止后按等待时间自动续期并重新上线，重启期间该账号会短暂停止收菜；微信授权到期前的预防性续期由后端常开执行，无需开关、也不依赖是否打开网页。
        </p>
      </div>
    </AccountSettingsDialog>
  </div>
</template>
