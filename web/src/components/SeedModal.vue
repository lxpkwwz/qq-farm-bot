<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'

const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits(['close', 'saved'])

const loading = ref(false)
const errorMessage = ref('')
const imagePreview = ref('')
const imageFile = ref<File | null>(null)

// 表单数据
const form = reactive({
  seed_id: '',
  name: '',
  grow_phases: '',
  land_level_need: '',
  seasons: '1',
  fruit_count: '200',
  price: '',
  exp: '',
  size: '0',
})

// 生长阶段预设模板
const phaseTemplates = [
  { label: '4小时 (6阶段)', value: '种子:2400;发芽:2400;小叶子:2400;大叶子:2400;开花:2400;成熟:0;' },
  { label: '8小时 (6阶段)', value: '种子:4800;发芽:4800;小叶子:4800;大叶子:4800;开花:4800;成熟:0;' },
  { label: '12小时 (6阶段)', value: '种子:7200;发芽:7200;小叶子:7200;大叶子:7200;开花:7200;成熟:0;' },
  { label: '24小时 (6阶段)', value: '种子:14400;发芽:14400;小叶子:14400;大叶子:14400;开花:14400;成熟:0;' },
  { label: '自定义', value: 'custom' },
]

const selectedTemplate = ref('')

// 季节选项
const seasonOptions = [
  { value: '1', label: '单季' },
  { value: '2', label: '双季' },
]

// 作物大小选项
const sizeOptions = [
  { value: '0', label: '1×1（普通作物）' },
  { value: '2', label: '2×2（占地4格）' },
]

function handleTemplateChange() {
  if (selectedTemplate.value && selectedTemplate.value !== 'custom') {
    form.grow_phases = selectedTemplate.value
  }
}

function handleImageSelect(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  // 验证文件类型
  const allowed = ['image/png', 'image/jpeg', 'image/webp']
  if (!allowed.includes(file.type)) {
    errorMessage.value = '仅支持 png, jpg, webp 格式图片'
    return
  }

  // 验证文件大小
  if (file.size > 2 * 1024 * 1024) {
    errorMessage.value = '图片大小不能超过 2MB'
    return
  }

  imageFile.value = file
  errorMessage.value = ''

  // 预览
  const reader = new FileReader()
  reader.onload = (e) => {
    imagePreview.value = e.target?.result as string
  }
  reader.readAsDataURL(file)
}

function removeImage() {
  imageFile.value = null
  imagePreview.value = ''
}

function parseGrowTime(phases: string): number {
  if (!phases) return 0
  let total = 0
  const parts = phases.split(';').filter(p => p)
  for (const part of parts) {
    const match = part.match(/:(\d+)$/)
    if (match && match[1]) {
      total += Number.parseInt(match[1])
    }
  }
  return total
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
  const hours = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  return mins > 0 ? `${hours}时${mins}分` : `${hours}时`
}

async function submit() {
  errorMessage.value = ''

  // 验证必填字段
  if (!form.seed_id || Number(form.seed_id) <= 0) {
    errorMessage.value = '请输入有效的种子ID'
    return
  }
  if (!form.name.trim()) {
    errorMessage.value = '请输入作物名称'
    return
  }
  if (!form.grow_phases.trim()) {
    errorMessage.value = '请填写生长阶段'
    return
  }
  if (!form.land_level_need || Number(form.land_level_need) <= 0) {
    errorMessage.value = '请输入有效的等级要求'
    return
  }
  if (!form.fruit_count || Number(form.fruit_count) <= 0) {
    errorMessage.value = '请输入有效的收获数量'
    return
  }
  if (form.price === '' || form.price === undefined || form.price === null) {
    errorMessage.value = '请输入种子价格'
    return
  }
  if (!imageFile.value) {
    errorMessage.value = '请上传种子图片'
    return
  }

  loading.value = true
  try {
    const formData = new FormData()
    formData.append('seed_id', form.seed_id)
    formData.append('name', form.name.trim())
    formData.append('grow_phases', form.grow_phases.trim())
    formData.append('land_level_need', form.land_level_need)
    formData.append('seasons', form.seasons)
    formData.append('fruit_count', form.fruit_count)
    formData.append('price', form.price)
    if (form.exp) formData.append('exp', form.exp)
    if (form.size) formData.append('size', form.size)
    if (imageFile.value) formData.append('image', imageFile.value)

    const res = await api.post('/api/seed', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      skipErrorToast: true,
    } as any)

    if (res.data.ok) {
      emit('saved')
      close()
    } else {
      errorMessage.value = `保存失败: ${res.data.error}`
    }
  } catch (e: any) {
    errorMessage.value = `保存失败: ${e.response?.data?.error || e.message}`
  } finally {
    loading.value = false
  }
}

function close() {
  emit('close')
}

watch(() => props.show, (newVal) => {
  if (newVal) {
    errorMessage.value = ''
    imagePreview.value = ''
    imageFile.value = null
    selectedTemplate.value = ''
    form.seed_id = ''
    form.name = ''
    form.grow_phases = ''
    form.land_level_need = ''
    form.seasons = '1'
    form.fruit_count = '200'
    form.price = ''
    form.exp = ''
    form.size = '0'
  }
})
</script>

<template>
  <div v-if="show" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
    <div class="max-h-[90vh] max-w-lg w-full overflow-hidden rounded-2xl" :style="{ background: 'var(--theme-bg)', boxShadow: 'var(--theme-shadow-lg, 0 8px 32px rgba(0,0,0,0.16))' }">
      <!-- Header -->
      <div class="flex items-center justify-between p-4" style="border-bottom: 1px solid color-mix(in srgb, var(--theme-text) 10%, transparent)">
        <h3 class="text-lg font-semibold" style="color: var(--theme-primary, var(--theme-text))">
          🌱 种子录入
        </h3>
        <BaseButton variant="ghost" class="!p-1" @click="close">
          <div class="i-carbon-close text-xl" :style="{ color: 'var(--theme-text)' }" />
        </BaseButton>
      </div>

      <div class="max-h-[calc(90vh-80px)] overflow-y-auto p-4">
        <!-- 错误信息 -->
        <div v-if="errorMessage" class="mb-4 rounded-xl p-3 text-sm" style="background: rgba(239, 68, 68, 0.1); color: #ef4444">
          {{ errorMessage }}
        </div>

        <div class="space-y-4">
          <!-- 基本信息 -->
          <div class="rounded-xl bg-gray-50 p-3 dark:bg-gray-700/50">
            <div class="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
              📋 基本信息（必填）
            </div>
            <div class="grid grid-cols-2 gap-3">
              <BaseInput
                v-model="form.seed_id"
                label="种子ID"
                placeholder="如: 20069"
                type="number"
                class="farm-input"
              />
              <BaseInput
                v-model="form.name"
                label="作物名称"
                placeholder="如: 草莓"
                class="farm-input"
              />
              <BaseInput
                v-model="form.land_level_need"
                label="等级要求"
                placeholder="如: 38"
                type="number"
                class="farm-input"
              />
              <BaseSelect
                v-model="form.seasons"
                label="季节数"
                :options="seasonOptions"
                class="farm-input"
              />
            </div>
          </div>

          <!-- 收益信息 -->
          <div class="rounded-xl bg-gray-50 p-3 dark:bg-gray-700/50">
            <div class="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
              💰 收益信息（必填）
            </div>
            <div class="grid grid-cols-2 gap-3">
              <BaseInput
                v-model="form.fruit_count"
                label="单次收获数量"
                placeholder="如: 200"
                type="number"
                class="farm-input"
              />
              <BaseInput
                v-model="form.price"
                label="种子价格（金币）"
                placeholder="0 表示免费"
                type="number"
                class="farm-input"
              />
            </div>
          </div>

          <!-- 生长阶段 -->
          <div class="rounded-xl bg-gray-50 p-3 dark:bg-gray-700/50">
            <div class="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
              ⏱️ 生长阶段（必填）
            </div>
            <div class="mb-2">
              <label class="mb-1 block text-xs text-gray-500">快速模板</label>
              <select
                v-model="selectedTemplate"
                class="w-full border border-gray-300 rounded-lg bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                @change="handleTemplateChange"
              >
                <option value="">选择模板...</option>
                <option v-for="tpl in phaseTemplates" :key="tpl.value" :value="tpl.value">
                  {{ tpl.label }}
                </option>
              </select>
            </div>
            <BaseTextarea
              v-model="form.grow_phases"
              label="生长阶段配置"
              placeholder="格式: 阶段名:秒数;阶段名:秒数;...如: 种子:7200;发芽:7200;成熟:0;"
              :rows="2"
              class="farm-input"
            />
            <div v-if="form.grow_phases" class="mt-1 text-xs text-gray-500">
              总生长时间: {{ formatTime(parseGrowTime(form.grow_phases)) }}
            </div>
          </div>

          <!-- 选填信息 -->
          <div class="rounded-xl bg-gray-50 p-3 dark:bg-gray-700/50">
            <div class="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
              📝 选填信息
            </div>
            <div class="grid grid-cols-2 gap-3">
              <BaseInput
                v-model="form.exp"
                label="收获经验"
                placeholder="默认: 0"
                type="number"
                class="farm-input"
              />
              <BaseSelect
                v-model="form.size"
                label="作物大小"
                :options="sizeOptions"
                class="farm-input"
              />
            </div>
          </div>

          <!-- 种子图片 -->
          <div class="rounded-xl bg-gray-50 p-3 dark:bg-gray-700/50">
            <div class="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
              🖼️ 种子图片（必填）
            </div>
            <div class="flex items-center gap-3">
              <div
                v-if="imagePreview"
                class="relative h-16 w-16 flex shrink-0 items-center justify-center overflow-hidden border border-gray-200 rounded-lg bg-white dark:border-gray-600"
              >
                <img :src="imagePreview" class="h-14 w-14 object-contain">
                <button
                  class="absolute -right-1 -top-1 h-5 w-5 flex items-center justify-center rounded-full bg-red-500 text-xs text-white"
                  @click="removeImage"
                >
                  ✕
                </button>
              </div>
              <label
                class="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-gray-300 px-4 py-3 text-sm text-gray-500 transition hover:border-blue-400 hover:text-blue-500 dark:border-gray-600 dark:hover:border-blue-500"
              >
                <span class="text-lg">📷</span>
                <span>{{ imagePreview ? '更换图片' : '选择图片' }}</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  class="hidden"
                  @change="handleImageSelect"
                >
              </label>
            </div>
            <div class="mt-1 text-xs text-gray-400">
              支持 png, jpg, webp 格式，最大 2MB
            </div>
          </div>

          <!-- 提交按钮 -->
          <div class="flex justify-end gap-2 pt-2">
            <BaseButton variant="outline" class="cartoon-btn" @click="close">
              取消
            </BaseButton>
            <BaseButton variant="primary" class="cartoon-btn" :loading="loading" @click="submit">
              🌱 录入种子
            </BaseButton>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
