import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { SITE_NAME } from '@/brand'
import { useAuthStore } from '@/stores/auth'

/**
 * One SPA, two audiences.
 *
 * The back office is declared first so that `/admin` is never swallowed by the
 * public `/:section` route (the public nav keys live in the `sections` table and
 * none of them is called "admin").
 */
const routes: RouteRecordRaw[] = [
  /* ------------------------------------------------------------ back office */
  {
    path: '/admin/login',
    name: 'admin-login',
    component: () => import('@/admin/views/LoginView.vue'),
    meta: { title: 'Sign in' },
  },
  {
    path: '/admin',
    component: () => import('@/admin/layouts/AdminLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      { path: '', name: 'admin-dashboard', component: () => import('@/admin/views/DashboardView.vue'), meta: { title: 'Overview' } },
      { path: 'articles', name: 'admin-articles', component: () => import('@/admin/views/ArticleListView.vue'), meta: { title: 'Articles' } },
      { path: 'articles/new', name: 'admin-article-new', component: () => import('@/admin/views/ArticleEditView.vue'), meta: { title: 'New article' } },
      { path: 'articles/:id(\\d+)', name: 'admin-article-edit', component: () => import('@/admin/views/ArticleEditView.vue'), props: true, meta: { title: 'Edit article' } },
      { path: 'collections', name: 'admin-collections', component: () => import('@/admin/views/CollectionListView.vue'), meta: { title: 'Collections' } },
      { path: 'collections/new', name: 'admin-collection-new', component: () => import('@/admin/views/CollectionEditView.vue'), meta: { title: 'New collection' } },
      { path: 'collections/:id(\\d+)', name: 'admin-collection-edit', component: () => import('@/admin/views/CollectionEditView.vue'), props: true, meta: { title: 'Edit collection' } },
      { path: 'images', name: 'admin-images', component: () => import('@/admin/views/ImageLibraryView.vue'), meta: { title: 'Images' } },
      { path: 'feed', name: 'admin-feed', component: () => import('@/admin/views/FeedEditView.vue'), meta: { title: 'Home feed' } },
      { path: 'pages', name: 'admin-pages', component: () => import('@/admin/views/PageListView.vue'), meta: { title: 'Pages' } },
      { path: 'pages/:slug', name: 'admin-page-edit', component: () => import('@/admin/views/PageEditView.vue'), props: true, meta: { title: 'Edit page' } },
      { path: 'users', name: 'admin-users', component: () => import('@/admin/views/UserListView.vue'), meta: { title: 'People' } },
      { path: 'roles', name: 'admin-roles', component: () => import('@/admin/views/RoleMatrixView.vue'), meta: { title: 'Roles' } },
      { path: 'audit', name: 'admin-audit', component: () => import('@/admin/views/AuditView.vue'), meta: { title: 'Activity' } },
      { path: 'data', name: 'admin-data', component: () => import('@/admin/views/DataImportView.vue'), meta: { title: 'Data' } },
    ],
  },

  /* ------------------------------------------------------------ public site */
  {
    path: '/',
    component: () => import('@/site/layouts/SiteLayout.vue'),
    children: [
      { path: '', name: 'feed', component: () => import('@/site/views/FeedView.vue') },
      { path: ':section', name: 'section', component: () => import('@/site/views/SectionView.vue'), props: true },
      { path: ':section/:slug', name: 'section-entry', component: () => import('@/site/views/SectionView.vue'), props: true },
    ],
  },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('@/site/views/NotFoundView.vue') },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()

  if (to.meta.requiresAuth) {
    await auth.ensureLoaded()
    if (!auth.isAuthenticated) {
      return { name: 'admin-login', query: { redirect: to.fullPath } }
    }
  }

  if (to.name === 'admin-login') {
    await auth.ensureLoaded()
    if (auth.isAuthenticated) return { name: 'admin-dashboard' }
  }

  return true
})

router.afterEach((to) => {
  // public views refine this once their content has loaded (see FeedView/SectionView)
  const title = to.meta.title as string | undefined
  document.title = title ? `${title} – ${SITE_NAME}` : SITE_NAME
})
