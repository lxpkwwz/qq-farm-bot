<script setup lang="ts">
import { computed } from 'vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { INTERVAL_INPUT_MIN, INTERVAL_MAX_SECONDS } from '@/utils/interval-limits'

interface StrategyTimingSettings {
  intervals: {
    farmMin: number
    farmMax: number
    helpMin: number
    helpMax: number
  }
  friendQuietHours: {
    enabled: boolean
    start: string
    end: string
  }
}

withDefaults(defineProps<{ section?: 'all' | 'planting' | 'friends' }>(), { section: 'all' })
const settings = defineModel<StrategyTimingSettings>('settings', { required: true })
type IntervalKey = keyof StrategyTimingSettings['intervals']

function intervalModel(key: IntervalKey) {
  return computed({
    get: () => settings.value.intervals[key],
    set: (value: number | string) => {
      const parsed = Number.parseInt(String(value), 10)
      // 输入框有 max，但清空 / 粘贴 / 程序赋值都能绕过它，所以这里再夹一次：
      // 服务端同样夹到 86400，两边不一致时用户会看到「保存后数字被悄悄改小」。
      const next = Number.isFinite(parsed)
        ? Math.min(INTERVAL_MAX_SECONDS, Math.max(INTERVAL_INPUT_MIN, parsed))
        : INTERVAL_INPUT_MIN
      settings.value = {
        ...settings.value,
        intervals: {
          ...settings.value.intervals,
          [key]: next,
        },
      }
    },
  })
}

const farmMin = intervalModel('farmMin')
const farmMax = intervalModel('farmMax')
const helpMin = intervalModel('helpMin')
const helpMax = intervalModel('helpMax')
</script>

<template>
  <div class="space-y-3">
    <div v-if="section === 'all' || section === 'planting'" class="grid grid-cols-2 gap-3 md:grid-cols-2">
      <BaseInput
        v-model.number="farmMin"
        label="农场巡查最小 (秒)"
        type="number"
        :min="INTERVAL_INPUT_MIN"
        :max="INTERVAL_MAX_SECONDS"
      />
      <BaseInput
        v-model.number="farmMax"
        label="农场巡查最大 (秒)"
        type="number"
        :min="INTERVAL_INPUT_MIN"
        :max="INTERVAL_MAX_SECONDS"
      />
    </div>

    <div v-if="section === 'all' || section === 'friends'" class="grid grid-cols-2 gap-3 md:grid-cols-2">
      <BaseInput
        v-model.number="helpMin"
        label="帮助巡查最小 (秒)"
        type="number"
        :min="INTERVAL_INPUT_MIN"
        :max="INTERVAL_MAX_SECONDS"
      />
      <BaseInput
        v-model.number="helpMax"
        label="帮助巡查最大 (秒)"
        type="number"
        :min="INTERVAL_INPUT_MIN"
        :max="INTERVAL_MAX_SECONDS"
      />
    </div>

    <div v-if="section === 'all' || section === 'friends'" class="flex flex-wrap items-center gap-4 border-t pt-3 dark:border-gray-700">
      <BaseSwitch
        v-model="settings.friendQuietHours.enabled"
        label="启用静默时段"
      />
      <div class="flex items-center gap-2">
        <input
          v-model="settings.friendQuietHours.start"
          type="time"
          class="w-20 border border-gray-200 rounded bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          :disabled="!settings.friendQuietHours.enabled"
        >
        <span class="text-xs text-gray-500">-</span>
        <input
          v-model="settings.friendQuietHours.end"
          type="time"
          class="w-20 border border-gray-200 rounded bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          :disabled="!settings.friendQuietHours.enabled"
        >
      </div>
      <p class="w-full text-xs text-gray-400 dark:text-gray-500">
        每日静默时段按北京时间（UTC+8）执行，不受服务器时区影响。
      </p>
      <p class="w-full text-xs text-gray-400 dark:text-gray-500">
        时段内暂停常规农场、偷菜、帮助、捣乱和重点好友动作；自己的成熟收获与收后补种优先，完成后继续静默。保留连接心跳与手动查询，到点自动恢复。
      </p>
    </div>
  </div>
</template>

<style scoped>
.idle-rest-settings :deep(.base-input) {
  min-height: 42px;
}
</style>
