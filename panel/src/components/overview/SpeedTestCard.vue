<template>
  <div class="card w-full">
    <div class="card-title flex items-center gap-2 px-4 pt-4">
      <span>⚡ {{ $t('speedTest') }}</span>
      <label class="ml-auto flex cursor-pointer items-center gap-2 text-sm font-normal">
        <span class="text-base-content/70">{{ $t('autoSpeedTest') }}</span>
        <input
          v-model="autoSpeedTest"
          type="checkbox"
          class="toggle toggle-sm toggle-primary"
        />
      </label>
      <button
        class="btn btn-ghost btn-sm"
        :disabled="testing"
        @click="runAll"
      >
        {{ $t('retest') }}
      </button>
    </div>
    <div class="card-body">
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div
          v-for="site in sites"
          :key="site.url"
          class="bg-base-200/60 rounded-2xl p-3"
        >
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium">{{ site.name }}</span>
            <span
              class="text-lg font-bold tabular-nums"
              :class="latencyClass(results[site.url]?.ms)"
            >
              {{ results[site.url]?.ms == null ? '--' : `${results[site.url].ms}` }}
              <span class="text-xs font-normal">ms</span>
            </span>
          </div>
          <div class="mt-2 flex h-8 items-end gap-0.5">
            <div
              v-for="(v, i) in history[site.url] || []"
              :key="i"
              class="w-full rounded-sm"
              :class="latencyBarClass(v)"
              :style="{ height: `${barHeight(v)}%` }"
            />
            <div
              v-if="!(history[site.url] || []).length"
              class="text-base-content/40 w-full text-center text-xs"
            >
              {{ $t('notTested') }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { autoSpeedTest, speedTestSites, speedtestTimeout } from '@/store/settings'
import { onMounted, onUnmounted, reactive, ref, watch } from 'vue'

interface Result {
  ms: number | null
}

const sites = speedTestSites
const results = reactive<Record<string, Result>>({})
const history = reactive<Record<string, number[]>>({})
const testing = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

const HIST_LEN = 24

function latencyClass(ms: number | null | undefined) {
  if (ms == null) return 'text-base-content/40'
  if (ms < 500) return 'text-success'
  if (ms < 1000) return 'text-warning'
  return 'text-error'
}

function latencyBarClass(v: number) {
  if (v < 500) return 'bg-success/70'
  if (v < 1000) return 'bg-warning/70'
  return 'bg-error/70'
}

function barHeight(v: number) {
  return Math.max(8, Math.min(100, (v / 1500) * 100))
}

async function testOne(url: string): Promise<number | null> {
  const t0 = performance.now()
  try {
    await Promise.race([
      fetch(`${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`, {
        mode: 'no-cors',
        cache: 'no-store',
        credentials: 'omit',
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), speedtestTimeout.value)),
    ])
    return Math.round(performance.now() - t0)
  } catch {
    return null
  }
}

async function runAll() {
  if (testing.value) return
  testing.value = true
  try {
    const out = await Promise.all(sites.value.map((s) => testOne(s.url)))
    out.forEach((ms, i) => {
      const url = sites.value[i].url
      results[url] = { ms }
      if (ms != null) {
        const h = history[url] || (history[url] = [])
        h.push(ms)
        if (h.length > HIST_LEN) h.shift()
      }
    })
  } finally {
    testing.value = false
  }
}

function startAuto() {
  stopAuto()
  runAll()
  timer = setInterval(runAll, 5 * 60 * 1000)
}

function stopAuto() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

watch(autoSpeedTest, (on) => (on ? startAuto() : stopAuto()))

onMounted(() => {
  if (autoSpeedTest.value) startAuto()
})

onUnmounted(stopAuto)
</script>
