import './assets/main.css'
import 'highlight.js/styles/github-dark-dimmed.css'

import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import translate from 'i18n-jsautotranslate'

/** 在 Vercel 上启用 Web Analytics；静态站点不再请求自建访问统计 API。 */
function initHostedAnalytics() {
  if (import.meta.env.VITE_ANALYTICS_PROVIDER !== 'vercel') return
  if (document.querySelector('script[data-vercel-analytics]')) return
  const script = document.createElement('script')
  script.defer = true
  script.src = '/_vercel/insights/script.js'
  script.dataset.vercelAnalytics = 'true'
  document.head.appendChild(script)
}

initHostedAnalytics()

const app = createApp(App)

app.use(createPinia())
app.use(router)

app.mount('#app')

// 将翻译实例挂到全局,供 i18n/index.ts 切换语言时调用
window.translate = translate

// 等待首屏挂载后再初始化翻译服务,避免阻塞渲染
nextTick(() => {
  translate.language.setLocal('chinese_simplified') // 页面源语言为简体中文
  translate.service.use('client.edge') // 使用 Edge 浏览器端翻译服务
  translate.selectLanguageTag.show = false // 隐藏内置语言选择器(用自定义的 NavBar 切换)
  translate.listener.start() // 监听 DOM 变化,自动翻译动态内容
  translate.execute() // 立即执行一次翻译
})
