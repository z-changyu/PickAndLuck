import { Application } from 'pixi.js'

/**
 * Pixi 应用（阶段一渲染入口）。
 *
 * 尺寸自己按宿主容器算，不用 resizeTo：场景布局是显式坐标，必须自己知道有多大。
 * 这里也是「阶段二换 Cocos」时唯一需要整体替换的文件之一（另一个是 storage.ts）。
 */
export async function createGameApp(host: HTMLElement): Promise<Application> {
  const app = new Application()
  await app.init({
    background: 0xf7f6f3,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
  })

  host.append(app.canvas)
  return app
}

/** 把画布尺寸同步为宿主容器尺寸；返回尺寸是否真的变了 */
export function syncCanvasSize(app: Application, host: HTMLElement): boolean {
  const width = Math.max(320, Math.floor(host.clientWidth))
  const height = Math.max(240, Math.floor(host.clientHeight))

  if (app.screen.width === width && app.screen.height === height) return false
  app.renderer.resize(width, height)
  return true
}
