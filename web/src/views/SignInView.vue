<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import { buildLabel } from '../../../shared/build-info'
import BrandMark from '../app/BrandMark.vue'
import LanguageSelect from '../app/LanguageSelect.vue'
import InstancePicker from '../instances/InstancePicker.vue'
import InstanceSetup from '../instances/InstanceSetup.vue'
import {
  activeInstance,
  activeInstanceId,
  hasActiveInstance,
  instances,
} from '../instances/instances'
import { useSessionStore } from '../stores/session'
import { useShellStore } from '../stores/shell'

// Everything before a workspace exists: choosing an instance, reaching it, signing in.
const { t } = useI18n()
const router = useRouter()
const session = useSessionStore(),
  shell = useShellStore()
const password = ref('')
watch(activeInstanceId, () => {
  password.value = ''
})
async function signIn() {
  if (await session.login(password.value)) password.value = ''
}
</script>

<template>
  <div class="login-screen" :class="{ 'mobile-layout': shell.mobile }" :style="shell.viewportStyle">
    <main class="login-content">
      <header class="login-header">
        <BrandMark class="login-brand" :size="27" />
        <LanguageSelect />
      </header>
      <InstancePicker
        v-if="instances.length"
        :disabled="session.signingIn"
        @connect="session.connect"
      />
      <InstanceSetup
        v-if="
          !hasActiveInstance ||
          (!session.unknownInstance && !session.checking && session.unavailable)
        "
        :message="session.setupMessage ? t(session.setupMessage) : ''"
        @connect="session.connect"
      />
      <div v-else-if="session.unknownInstance" class="login-form">
        <UAlert
          color="warning"
          variant="subtle"
          :title="t('canvasUi.unknownInstance')"
          role="status"
        />
        <UButton
          size="lg"
          block
          @click="router.push({ name: 'instance', params: { instance: activeInstance.id } })"
        >
          {{ t('canvasUi.openInstance') }}
        </UButton>
      </div>
      <div v-else-if="session.checking" class="instance-checking" role="status">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        {{ t('common.loading') }}
      </div>
      <form v-else class="login-form" @submit.prevent="signIn">
        <div class="login-endpoint">
          <p class="login-address" :title="activeInstance.base">{{ activeInstance.base }}</p>
          <span
            v-if="session.serverBuild"
            class="login-version"
            :title="`${t('instances.serverVersion')}: ${session.serverBuild.build.version}${session.serverBuild.build.revision ? ` · ${session.serverBuild.build.revision}` : ''}`"
          >
            {{ buildLabel(session.serverBuild.build) }}
          </span>
        </div>
        <UFormField :label="t('app.username')" required>
          <UInput
            v-model="session.username"
            name="username"
            autocomplete="username"
            required
            :autofocus="!session.username"
            size="lg"
            class="w-full"
          />
        </UFormField>
        <UFormField :label="t('app.passwordLabel')" required>
          <UInput
            v-model="password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
            :autofocus="!!session.username"
            size="lg"
            class="w-full"
          />
        </UFormField>
        <UAlert
          v-if="session.loginError"
          color="error"
          variant="subtle"
          :title="session.loginError"
          role="alert"
        />
        <UButton type="submit" size="lg" block :loading="session.signingIn">
          {{ session.signingIn ? t('app.signingIn') : t('app.signIn') }}
        </UButton>
      </form>
    </main>
    <div :ref="shell.adoptOverlayRoot" class="overlay-root" />
  </div>
</template>
