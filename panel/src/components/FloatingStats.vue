<template>
  <div
    v-if="visible"
    class="fixed bottom-4 left-4 z-40 w-56"
  >
    <div class="card">
      <div class="flex items-center justify-between px-3 pt-2">
        <span class="text-xs font-semibold">
          <span
            class="mr-1 inline-block h-2 w-2 rounded-full"
            :class="running ? 'bg-success animate-pulse' : 'bg-error'"
          />
          {{ running ? $t('running') : $t('notConnected') }}
        </span>
        <button
          class="btn btn-ghost btn-xs"
          @click="collapsed = !collapsed"
        >
          {{ collapsed ? '▲' : '▼' }}
        </button>
      </div>
      <div
        v-if="!collapsed"
        class="card-body grid grid-cols-2 gap-x-3 gap-y-2 pt-1 text-xs"
      >
        <div>
          <div class="text-base-content/60">🔗 {{ $t('connections') }}</div>
          <div class="text-base font-bold tabular-nums">{{ connections }}</div>
        </div>
        <div>
          <div class="text-base-content/60">💾 {{ $t('memoryUsage') }}</div>
          <div class="text-base font-bold tabular-nums">{{ fmtBytes(memory) }}</div>
        </div>
        <div>
          <div class="text-base-content/60">🔽 {{ $t('download') }}</div>
          <div class="text-base font-bold tabular-nums">{{ fmtBytes(totalDown) }}</div>
          <div class="text-base-content/60 tabular-nums">{{ fmtRate(downRate) }}</div>
        </div>
        <div>
          <div class="text-base-content/60">🔼 {{ $t('upload') }}</div>
          <div class="text-base font-bold tabular-nums">{{ fmtBytes(totalUp) }}</div>
          <div class="text-base-content/60 tabular-nums">{{ fmtRate(upRate) }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { prettyBytesHelper } from '@/helper/utils'
import { serverAuthenticated } from '@/store/auth'
import { activeConnections } from '@/store/connections'
import { downloadSpeed, memory, uploadSpeed } from '@/store/overview'
import { useStorage } from '@vueuse/core'
import { computed, ref, watch } from 'vue'

const showWidget = useStorage('config/floating-stats-visible', true)
const visible = computed(() => showWidget.value && serverAuthenticated.value)
const collapsed = ref(false)

const connections = computed(() => activeConnections.value.length)

// The clash traffic stream reports cumulative bytes; derive per-second rates.
const lastSample = ref<{ up: number; down: number; at: number } | null>(null)
const downRate = ref(0)
const upRate = ref(0)
const lastSeenAt = ref(0)
const running = computed(() => Date.now() - lastSeenAt.value < 8000)

watch(
  [downloadSpeed, uploadSpeed],
  ([down, up]) => {
    const at = Date.now()
    lastSeenAt.value = at
    const prev = lastSample.value
    if (prev && at > prev.at) {
      const dt = (at - prev.at) / 1000
      downRate.value = Math.max(0, (down - prev.down) / dt)
      upRate.value = Math.max(0, (up - prev.up) / dt)
    }
    lastSample.value = { up, down, at }
  },
  { immediate: true },
)

const totalDown = computed(() => downloadSpeed.value || 0)
const totalUp = computed(() => uploadSpeed.value || 0)

function fmtBytes(v: number) {
  return prettyBytesHelper(v || 0, { maximumFractionDigits: 1 })
}
function fmtRate(v: number) {
  return `${fmtBytes(v)}/s`
}
</script>
