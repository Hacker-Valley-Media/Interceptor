type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

export async function handleForms(_action: Action): Promise<ActionResult> {
  const forms = document.querySelectorAll("form")
  return {
    success: true, data: Array.from(forms).map((f, i) => ({
      index: i,
      action: f.action,
      method: f.method,
      id: f.id || undefined,
      fields: Array.from(f.elements).map(el => ({
        tag: el.tagName.toLowerCase(),
        type: (el as HTMLInputElement).type,
        name: (el as HTMLInputElement).name,
        value: (el as HTMLInputElement).value?.slice(0, 40),
        placeholder: (el as HTMLInputElement).placeholder
      }))
    }))
  }
}

export async function handleLinks(_action: Action): Promise<ActionResult> {
  const links = document.querySelectorAll("a[href]")
  return {
    success: true, data: Array.from(links).slice(0, 100).map(a => ({
      href: (a as HTMLAnchorElement).href,
      text: (a.textContent || "").trim().slice(0, 60)
    }))
  }
}

export async function handleImages(_action: Action): Promise<ActionResult> {
  const imgs = document.querySelectorAll("img")
  return {
    success: true, data: Array.from(imgs).slice(0, 50).map(img => ({
      src: (img as HTMLImageElement).src,
      alt: (img as HTMLImageElement).alt,
      width: (img as HTMLImageElement).naturalWidth,
      height: (img as HTMLImageElement).naturalHeight
    }))
  }
}

export async function handleMeta(_action: Action): Promise<ActionResult> {
  const metas = document.querySelectorAll("meta")
  const data: Record<string, string> = {}
  metas.forEach(m => {
    const key = m.getAttribute("name") || m.getAttribute("property") || m.getAttribute("http-equiv")
    const val = m.getAttribute("content")
    if (key && val) data[key] = val.slice(0, 200)
  })
  data["title"] = document.title
  data["canonical"] = (document.querySelector('link[rel="canonical"]') as HTMLLinkElement)?.href || ""
  data["lang"] = document.documentElement.lang || ""
  return { success: true, data }
}

export async function handlePageInfo(_action: Action): Promise<ActionResult> {
  return {
    success: true, data: {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      doctype: document.doctype?.name,
      charset: document.characterSet,
      referrer: document.referrer,
      contentType: document.contentType,
      lastModified: document.lastModified,
      domain: document.domain,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: window.scrollX, y: window.scrollY, maxX: document.documentElement.scrollWidth, maxY: document.documentElement.scrollHeight }
    }
  }
}
