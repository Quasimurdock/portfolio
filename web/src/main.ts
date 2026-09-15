import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { lazyImage } from './composables/useLazyImage'

import './styles/site.css'
import './styles/admin.css'

const app = createApp(App)

app.use(createPinia())
app.directive('lazy', lazyImage)
app.use(router)

app.mount('#app')
