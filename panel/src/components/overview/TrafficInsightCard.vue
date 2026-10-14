<template>
  <div class="card w-full">
    <div class="card-title flex items-center gap-2 px-4 pt-4">
      <span>{{ $t('trafficInsight') }}</span>
      <div class="ml-auto flex items-center gap-1 text-sm font-normal">
        <button
          class="btn btn-ghost btn-xs"
          @click="shiftMonth(-1)"
        >
          &lt;
        </button>
        <span class="min-w-24 text-center tabular-nums">{{ monthLabel }}</span>
        <button
          class="btn btn-ghost btn-xs"
          :disabled="isCurrentMonth"
          @click="shiftMonth(1)"
        >
          &gt;
        </button>
      </div>
    </div>
    <div class="card-body">
      <div class="text-base-content/70 text-sm">{{ summaryText }}</div>
      <div
        ref="chartEl"
        class="h-56 w-full"
      ></div>
      <div
        v-if="selected"
        class="bg-base-200/60 rounded-2xl p-3 text-sm"
      >
        <div class="font-semibold">{{ selected.day }}</div>
        <div class="mt-1 flex flex-wrap gap-x-6 gap-y-1">
          <span>{{ $t('download') }} <b>{{ fmt(selected.down) }}</b></span>
          <span>{{ $t('upload') }} <b>{{ fmt(selected.up) }}</b></span>
          <span>{{ $t('connections') }} <b>{{ selected.conns }}</b></span>
        </div>
      </div>
      <div
        v-else
        class="text-base-content/40 text-sm"
      >
        {{ $t('trafficInsightHint') }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { fetchTrafficMonth, type TrafficMonth } from '@/api/openbox'
import { prettyBytesHelper } from '@/helper/utils'
import { theme } from '@/store/settings'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

echarts.use([BarChart, LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

const { t, locale } = useI18n()

const now = new Date()
const year = ref(now.getFullYear())
const monthNum = ref(now.getMonth() + 1)
const data = ref<TrafficMonth | null>(null)
const selected = ref<{ day: string; up: number; down: number; conns: number } | null>(null)
const chartEl = ref<HTMLElement | null>(null)
let chart: echarts.ECharts | null = null

const monthKey = computed(() => `${year.value}-${String(monthNum.value).padStart(2, '0')}`)
const isCurrentMonth = computed(
  () => year.value === now.getFullYear() && monthNum.value === now.getMonth() + 1,
)
const monthLabel = computed(() => {
  const d = new Date(year.value, monthNum.value - 1, 1)
  return d.toLocaleDateString(locale.value.startsWith('zh') ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'long',
  })
})
const summaryText = computed(() => {
  if (!data.value) return t('loading')
  const total = data.value.totalUp + data.value.totalDown
  return t('trafficInsightSummary', {
    month: monthLabel.value,
    total: fmt(total),
    conns: data.value.totalConns,
  })
})

function fmt(bytes: number): string {
  return prettyBytesHelper(bytes, { maximumFractionDigits: 1 })
}

function shiftMonth(delta: number): void {
  let y = year.value
  let m = monthNum.value + delta
  if (m < 1) {
    m = 12
    y -= 1
  } else if (m > 12) {
    m = 1
    y += 1
  }
  if (y > now.getFullYear() || (y === now.getFullYear() && m > now.getMonth() + 1)) return
  year.value = y
  monthNum.value = m
}

async function load(): Promise<void> {
  selected.value = null
  try {
    data.value = await fetchTrafficMonth(monthKey.value)
  } catch {
    data.value = {
      month: monthKey.value,
      days: [],
      totalUp: 0,
      totalDown: 0,
      totalConns: 0,
      avgPerDay: 0,
    }
  }
  render()
}

function render(): void {
  if (!chartEl.value) return
  if (!chart) chart = echarts.init(chartEl.value)
  const days = data.value ? data.value.days : []
  const byDay = new Map(days.map((d) => [d.day, d]))
  const daysInMonth = new Date(year.value, monthNum.value, 0).getDate()
  const labels: string[] = []
  const downVals: number[] = []
  const upVals: number[] = []
  for (let d = 1; d <= daysInMonth; d += 1) {
    const key = `${monthKey.value}-${String(d).padStart(2, '0')}`
    labels.push(String(d))
    const row = byDay.get(key)
    downVals.push(row ? row.down : 0)
    upVals.push(row ? row.up : 0)
  }
  const avg = data.value ? data.value.avgPerDay : 0
  const darkMode = (document.body.getAttribute('data-theme') || '').includes('dark')
  const textColor = darkMode ? '#d7c9bb' : '#5b4a3a'
  const dlLabel = t('download')
  const ulLabel = t('upload')
  const avgLabel = t('avgPerDay')
  chart.setOption(
    {
      grid: { left: 56, right: 12, top: 30, bottom: 24 },
      legend: { top: 0, textStyle: { color: textColor }, data: [dlLabel, ulLabel] },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: Array<{ name: string; value: number; seriesName: string }>) => {
          const dayName = params[0] ? params[0].name : ''
          const lines = params.map((p) => `${p.seriesName}: ${fmt(p.value)}`)
          return `${monthKey.value}-${dayName}<br/>${lines.join('<br/>')}`
        },
      },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { color: textColor, interval: Math.ceil(daysInMonth / 15) },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: textColor, formatter: (v: number) => fmt(v) },
        splitLine: { lineStyle: { type: 'dashed', opacity: 0.35 } },
      },
      series: [
        {
          name: dlLabel,
          type: 'bar',
          stack: 'traffic',
          data: downVals,
          itemStyle: { color: '#4ade80', borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 18,
        },
        {
          name: ulLabel,
          type: 'bar',
          stack: 'traffic',
          data: upVals,
          itemStyle: { color: '#60a5fa', borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 18,
        },
        {
          name: avgLabel,
          type: 'line',
          data: labels.map(() => avg),
          symbol: 'none',
          lineStyle: { type: 'dashed', color: '#f59e0b', width: 1.5 },
          tooltip: { show: false },
        },
      ],
    },
    true,
  )
  chart.off('click')
  chart.on('click', (params: { name?: string }) => {
    if (params.name == null) return
    const key = `${monthKey.value}-${String(params.name).padStart(2, '0')}`
    const row = byDay.get(key)
    if (row) {
      selected.value = { day: key, up: row.up, down: row.down, conns: row.conns }
    } else {
      selected.value = { day: key, up: 0, down: 0, conns: 0 }
    }
  })
}

function onResize(): void {
  if (chart) chart.resize()
}

watch([year, monthNum], load)
watch(theme, render)
watch(locale, render)

onMounted(() => {
  window.addEventListener('resize', onResize)
  load()
})
onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  if (chart) {
    chart.dispose()
    chart = null
  }
})
</script>
