<script setup lang="ts">
/**
 * 管理后台登录页
 * 全屏布局,不使用 AdminLayout,视觉参考 art-design-pro 的登录页风格
 */
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { BASE_URL } from '@/api/client'

/** 加载状态 */
const loading = ref(false)
/** 错误信息 */
const errorMsg = ref('')
const route = useRoute()

const oauthErrors: Record<string, string> = {
  github_oauth_state: 'GitHub 登录状态已失效，请重新登录。',
  github_oauth_token: 'GitHub 没有返回有效登录令牌，请重试。',
  github_oauth_forbidden: '只有内容仓库拥有者才能进入后台。',
  github_oauth_email: 'GitHub 账号没有可用的已验证邮箱。',
  github_oauth_network: 'GitHub OAuth 请求失败，请检查 Node 服务网络和终端日志。',
}

onMounted(() => {
  const code = typeof route.query.error === 'string' ? route.query.error : ''
  errorMsg.value = oauthErrors[code] || ''
})

/** 跳转到服务端 GitHub OAuth 授权页。 */
function loginWithGithub() {
  window.location.href = `${BASE_URL}/api/v1/auth/github?redirect=${encodeURIComponent('/admin/dashboard')}`
}

</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <!-- 标题 -->
      <div class="login-header">
        <h1 class="login-title">博客管理后台</h1>
        <p class="login-subtitle">请登录以继续</p>
      </div>

      <p class="login-hint">仅限 GitHub 仓库拥有者登录</p>
      <el-button class="github-login-button" type="primary" plain :loading="loading" @click="loginWithGithub">
          使用 GitHub 账号登录
      </el-button>

        <!-- 错误提示 -->
        <el-alert
          v-if="errorMsg"
          :title="errorMsg"
          type="error"
          :closable="false"
          show-icon
          class="login-error"
        />

    </div>
  </div>
</template>

<style scoped>
.login-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100dvh;
  padding: 24px;
  background: #f1f4f2;
}

.login-card {
  width: 100%;
  max-width: 400px;
  padding: 32px;
  border: 1px solid #e4e4e7;
  border-radius: 18px;
  background: radial-gradient(circle at 100% 0%, rgba(31, 122, 104, 0.1), transparent 38%), #ffffff;
  box-shadow:
    0 1px 2px rgba(24, 24, 27, 0.04),
    0 18px 48px rgba(24, 24, 27, 0.08);
}

.login-header {
  margin-bottom: 32px;
  text-align: center;
}

.login-title {
  margin: 0 0 8px;
  color: #18181b;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.login-subtitle {
  margin: 0;
  color: #71717a;
  font-size: 14px;
}

.login-hint {
  margin: -12px 0 24px;
  color: #71717a;
  font-size: 13px;
  text-align: center;
}

.login-error {
  margin-bottom: 16px;
}

.github-login-button {
  width: 100%;
  margin-bottom: 12px;
}

@media (max-width: 480px) {
  .login-page {
    padding: 16px;
  }

  .login-card {
    padding: 24px 18px;
  }
}
</style>
