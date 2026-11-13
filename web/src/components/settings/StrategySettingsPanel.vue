<script setup lang="ts">
import type { Ref } from 'vue'
import { NButton } from 'naive-ui/es/button'
import { NTimePicker } from 'naive-ui/es/time-picker'
import { computed } from 'vue'
import BagSeedPriorityItem from '@/components/settings/BagSeedPriorityItem.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { usePlantingStrategy } from '@/composables/settings/usePlantingStrategy'
import { INTERVAL_INPUT_MIN, INTERVAL_MAX_SECONDS } from '@/utils/interval-limits'

const props = defineProps<{
  currentAccountId: string | number | null | undefined
  plantingStrategyOptions: { label: string, value: string }[]
  bagFallbackStrategyOptions: { label: string, value: string }[]
  landTypeOptions: { label: string, value: string }[]
}>()

const settings = defineModel<any>('settings', { required: true })
const accountIdRef = computed(() => props.currentAccountId) as Ref<string | number | null | undefined>

const {
  preferredSeedOptions,
  strategyPreviewLabel,
  bagSeeds,
  bagSeedsLoading,
  bagSeedsError,
  sortedBagSeeds,
  orphanRestrictedSeeds,
  draggingBagSeedId,
  setBagSeedLandTypes,
  handleBagFallbackStrategyChange,
  handlePreferredSeedChange,
  resetBagSeedPriority,
  moveBagSeedUp,
  moveBagSeedDown,
  startBagSeedDrag,
  endBagSeedDrag,
  dragOverBagSeed,
  dropBagSeed,
} = usePlantingStrategy({
  strategy: settings,
  accountId: accountIdRef,
  landTypeOptions: props.landTypeOptions,
})

const isBagPriority = computed(() => settings.value.plantingStrategy === 'bag_priority')
</script>

<template>
  <div class="planting-strategy space-y-4">
    <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
      <BaseSelect
        :model-value="settings.plantingStrategy"
        label="选种策略"
        :options="plantingStrategyOptions"
        @update:model-value="settings.plantingStrategy = String($event)"
      />
      <BaseSelect
        v-if="settings.plantingStrategy === 'preferred'"
        v-model="settings.preferredSeedId"
        label="优先种植种子"
        :options="preferredSeedOptions"
      />
      <BaseSelect
        v-else-if="isBagPriority && settings.bagSeedFallbackStrategy === 'preferred'"
        v-model="settings.preferredSeedId"
        label="优先种植种子"
        :options="preferredSeedOptions"
        @change="handlePreferredSeedChange"
      />
      <div v-else class="flex flex-col gap-1.5">
        <label class="text-sm text-gray-700 font-medium dark:text-gray-300">
          {{ isBagPriority ? '第二优先策略预览' : '策略选种预览' }}
        </label>
        <div class="min-h-11 w-full flex items-center justify-between border border-gray-200 rounded-lg border-dashed bg-gray-50 px-3 py-2 text-gray-500 dark:border-gray-600 dark:bg-gray-800/50 dark:text-gray-400">
          <span class="truncate">{{ strategyPreviewLabel ?? '加载中...' }}</span>
          <span class="i-carbon-information shrink-0 text-base text-gray-400" />
        </div>
      </div>
    </div>

    <div v-if="isBagPriority" class="space-y-3">
      <BaseSelect
        v-model="settings.bagSeedFallbackStrategy"
        label="第二优先策略"
        :options="bagFallbackStrategyOptions"
        @change="handleBagFallbackStrategyChange"
      />
      <div class="border border-gray-200 rounded-lg bg-gray-50/70 p-3 dark:border-gray-700 dark:bg-gray-800/40">
        <BaseSwitch
          v-model="settings.bagSeedMultiLandReservationEnabled"
          label="为高优先级多格种子预留土地"
        />
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          开启后可能暂时留空部分土地，直到明确排在前面的多格种子凑齐连续布局。默认关闭。
        </p>
      </div>
      <div class="border border-amber-200 rounded-lg bg-amber-50/70 p-3 space-y-3 dark:border-amber-800/50 dark:bg-amber-900/20">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div class="text-sm text-amber-900 font-semibold dark:text-amber-200">
              背包种子优先顺序
            </div>
            <p class="mt-1 text-xs text-amber-700/90 dark:text-amber-300/90">
              先按下方顺序消耗背包中的 1x1 / 2x2 种子；背包种子不足时，再按“第二优先策略”补种。切换第二优先策略或重置时会据此重新排序。
            </p>
            <p class="mt-1 text-xs text-amber-700/90 dark:text-amber-300/90">
              配了土地限制的种子会先占用它能种的地块，再由不限制的种子使用剩余空地。
            </p>
          </div>
          <NButton size="tiny" type="warning" secondary @click="resetBagSeedPriority">
            重置顺序
          </NButton>
        </div>
        <!-- 首次无数据时才显示加载中；有缓存回填时后台静默刷新，列表不闪。 -->
        <div v-if="bagSeedsLoading && bagSeeds.length === 0" class="py-4 text-center text-sm text-amber-700 dark:text-amber-300">
          加载中...
        </div>
        <div v-else-if="bagSeedsError" class="py-4 text-center text-sm text-red-600 dark:text-red-400">
          {{ bagSeedsError }}
        </div>
        <div v-else-if="bagSeeds.length === 0" class="py-4 text-center text-sm text-amber-700 dark:text-amber-300">
          背包中暂无 1x1 / 2x2 种子
        </div>
        <div v-else class="grid gap-2 sm:grid-cols-2">
          <BagSeedPriorityItem
            v-for="(seed, index) in sortedBagSeeds"
            :key="seed.seedId"
            :seed="seed"
            :index="index"
            :land-types="settings.bagSeedLandTypes[String(seed.seedId)]"
            :land-type-options="landTypeOptions"
            :dragging="draggingBagSeedId === seed.seedId"
            :can-move-up="index > 0"
            :can-move-down="index < sortedBagSeeds.length - 1"
            @move-up="moveBagSeedUp(seed.seedId)"
            @move-down="moveBagSeedDown(seed.seedId)"
            @update:land-types="setBagSeedLandTypes(seed.seedId, $event)"
            @drag-start="startBagSeedDrag(seed.seedId, $event)"
            @drag-end="endBagSeedDrag"
            @drag-over="dragOverBagSeed(seed.seedId, $event)"
            @drop="dropBagSeed(seed.seedId, $event)"
          />
        </div>
        <div v-if="orphanRestrictedSeeds.length > 0" class="border-t border-amber-200 pt-2 dark:border-amber-800/50">
          <div class="text-xs text-amber-800 dark:text-amber-300">
            未持有但已配限制
          </div>
          <p class="mt-1 text-[11px] text-amber-700/80 dark:text-amber-300/80">
            这些种子当前不在背包中，限制已保留，重新入库后仍生效。
          </p>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <span
              v-for="item in orphanRestrictedSeeds"
              :key="item.seedId"
              class="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
            >
              {{ item.name }} · {{ item.scope }}
              <button
                type="button"
                class="i-carbon-close text-amber-600 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100"
                :title="`清除 ${item.name} 的土地限制`"
                :aria-label="`清除 ${item.name} 的土地限制`"
                @click="setBagSeedLandTypes(item.seedId, [])"
              />
            </span>
          </div>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <BaseInput
        v-model.number="settings.intervals.farmMin"
        label="农场巡查最小 (秒)"
        type="number"
        :min="INTERVAL_INPUT_MIN"
        :max="INTERVAL_MAX_SECONDS"
      />
      <BaseInput
        v-model.number="settings.intervals.farmMax"
        label="农场巡查最大 (秒)"
        type="number"
        :min="INTERVAL_INPUT_MIN"
        :max="INTERVAL_MAX_SECONDS"
      />
      <BaseInput
        v-model.number="settings.intervals.friendMin"
        label="好友任务最小 (秒)"
        type="number"
        :min="INTERVAL_INPUT_MIN"
        :max="INTERVAL_MAX_SECONDS"
      />
      <BaseInput
        v-model.number="settings.intervals.friendMax"
        label="好友任务最大 (秒)"
        type="number"
        :min="INTERVAL_INPUT_MIN"
        :max="INTERVAL_MAX_SECONDS"
      />
    </div>

    <div class="flex flex-wrap items-center gap-4 border-t pt-3 dark:border-gray-700">
      <BaseSwitch
        v-model="settings.friendQuietHours.enabled"
        label="启用静默时段"
      />
      <div class="flex items-center gap-2">
        <NTimePicker
          v-model:formatted-value="settings.friendQuietHours.start"
          class="w-28"
          format="HH:mm"
          value-format="HH:mm"
          :clearable="false"
          :disabled="!settings.friendQuietHours.enabled"
          size="small"
        />
        <span class="text-xs text-gray-500">-</span>
        <NTimePicker
          v-model:formatted-value="settings.friendQuietHours.end"
          class="w-28"
          format="HH:mm"
          value-format="HH:mm"
          :clearable="false"
          :disabled="!settings.friendQuietHours.enabled"
          size="small"
        />
      </div>
      <BaseSwitch
        v-model="settings.friendQuietHours.continueFarm"
        label="静默时继续农场巡查"
        :disabled="!settings.friendQuietHours.enabled"
      />
    </div>

    <div class="border-t pt-3 space-y-3 dark:border-gray-700">
      <h4 class="text-sm text-gray-700 font-medium dark:text-gray-300">
        种植与偷菜延迟设置
      </h4>
      <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
        <BaseSwitch
          v-model="settings.plantOrderRandom"
          label="种植顺序随机"
        />
        <BaseInput
          v-model.number="settings.plantDelaySeconds"
          label="种植延迟 (秒)"
          type="number"
          min="0"
          max="60"
        />
        <BaseInput
          v-model.number="settings.stealDelaySeconds"
          label="偷菜延迟 (秒)"
          type="number"
          min="0"
          max="300"
        />
      </div>
    </div>
  </div>
</template>
