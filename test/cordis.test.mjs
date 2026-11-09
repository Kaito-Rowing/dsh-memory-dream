/**
 * Regression tests for the two composition-level bugs that the rest of the
 * suite could not see.
 *
 * The other test files drive the plugin through a plain object `ctx`:
 *
 *     const ctx = { tools: {...}, systemPrompt: {...} }
 *
 * That fake is convenient and wrong in exactly the two ways that mattered:
 *
 *  1. **Property reads never fail.** Real Cordis throws
 *     `cannot get property "x" without inject` for any service the plugin did
 *     not declare. A `try/catch` around `ctx[name]` therefore always yields
 *     `undefined`, so injection silently never installed — and the fake ctx
 *     made that look like it worked.
 *
 *  2. **Events are not waterfalls.** `agent/pre-step` is a waterfall whose
 *     last argument is the agent loop's own base callback. A listener that
 *     does not call `next()` vetoes the chain, so the step decision comes back
 *     `undefined` and every turn fails.
 *
 * This file uses a `ctx` that reproduces both rules, so a regression fails
 * here instead of in a live session. The behaviour encoded below was checked
 * against the real `@deepseek-ai/cordis` used by DSH.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let counter = 0

/**
 * A ctx that behaves like Cordis in the two ways that matter.
 *
 * Services are declared up front. Reading an undeclared one through the
 * property proxy throws; `ctx.get(name)` does not.
 */
function cordisLikeCtx({ services = {}, declared = ['tools'], waterfallEvents = [] } = {}) {
  const provided = new Map(Object.entries(services))
  const hooks = new Map()
  const deferred = []

  const base = {
    /** The supported optional-service read. Never throws. */
    get(name) {
      return provided.get(name)
    },

    /** Defer `callback` until every listed service is provided. */
    inject(names, callback) {
      const missing = names.filter((n) => !provided.has(n))
      if (missing.length === 0) {
        callback(target)
        return
      }
      deferred.push({ names, callback })
    },

    on(name, listener) {
      if (!hooks.has(name)) hooks.set(name, [])
      hooks.get(name).push(listener)
      return () => {}
    },
  }

  // The property proxy: only declared services resolve. Everything else throws
  // the way Cordis does — including a service that IS provided, because the
  // guard is about declaration, not availability. `isSpecialProperty` in
  // Cordis exempts symbols, numeric keys and underscore-prefixed names.
  const target = new Proxy(base, {
    get(obj, prop) {
      if (typeof prop === 'symbol') return obj[prop]
      if (prop.startsWith('_')) return obj[prop]
      if (Object.hasOwn(obj, prop)) return obj[prop]
      if (declared.includes(prop)) return provided.get(prop)
      throw new Error(`cannot get property "${prop}" without inject`)
    },
  })

  /** Provide a service after `apply` ran, firing deferred injections. */
  const provide = (name, value) => {
    provided.set(name, value)
    services[name] = value
    for (let i = deferred.length - 1; i >= 0; i--) {
      const entry = deferred[i]
      if (entry.names.every((n) => provided.has(n))) {
        deferred.splice(i, 1)
        entry.callback(target)
      }
    }
  }

  /**
   * Run a waterfall the way Cordis does: listeners outermost-first, each
   * receiving `next`. A listener that never calls `next` ends the chain and
   * its return value becomes the result.
   */
  const waterfall = async (name, payload, inner) => {
    const listeners = hooks.get(name) ?? []
    const dispatch = async (index) => {
      if (index >= listeners.length) return inner()
      let called = false
      const next = () => {
        if (called) throw new Error('next() called multiple times')
        called = true
        return dispatch(index + 1)
      }
      return listeners[index](payload, next)
    }
    return dispatch(0)
  }

  return { ctx: target, provide, waterfall, hooks }
}

function makeSystemPrompt(contexts) {
  return {
    context(c) {
      contexts.push(c)
      return () => {}
    },
    section() {
      return () => {}
    },
  }
}

function makeTools(registered) {
  return { register: (def) => registered.set(def.name, def) }
}

async function sandbox(fn) {
  const home = await mkdtemp(join(tmpdir(), 'memdream-cordis-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await fn(home)
  } finally {
    process.env.DSH_HOME = prev
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  }
}

/** Load a fresh plugin instance and apply it to the given ctx. */
async function boot(ctx, config = {}) {
  const id = ++counter
  const mod = await import(`../lib/index.js?cordis=${id}`)
  mod.apply(ctx, config)
  return mod
}

const signal = () => ({ signal: new AbortController().signal })

// ---------------------------------------------------------------- injection

test('cordis: injection installs when systemPrompt is mounted', async () => {
  await sandbox(async () => {
    const registered = new Map()
    const contexts = []
    const { ctx } = cordisLikeCtx({
      services: {
        systemPrompt: makeSystemPrompt(contexts),
        tools: makeTools(registered),
      },
    })

    await boot(ctx)

    assert.equal(contexts.length, 1, 'a prompt context must be registered')
    assert.equal(contexts[0].name, 'memory-dream:memory')

    await registered.get('memory').execute(
      { operations: [{ action: 'add', content: 'the deploy target is staging' }] },
      signal(),
    )

    const text = contexts[0].text({})
    assert.match(text, /Persistent memory/)
    assert.match(text, /the deploy target is staging/)
  })
})

test('cordis: an undeclared property read throws, so only ctx.get works', async () => {
  await sandbox(async () => {
    const registered = new Map()
    const contexts = []
    const { ctx } = cordisLikeCtx({
      services: {
        systemPrompt: makeSystemPrompt(contexts),
        tools: makeTools(registered),
      },
    })

    // This is the trap the plugin used to fall into.
    assert.throws(() => ctx.systemPrompt, /without inject/)
    // And this is the supported read.
    assert.ok(ctx.get('systemPrompt'))
  })
})

test('cordis: injection installs when systemPrompt appears after apply', async () => {
  await sandbox(async () => {
    const registered = new Map()
    const contexts = []
    const { ctx, provide } = cordisLikeCtx({
      services: { tools: makeTools(registered) },
    })

    await boot(ctx)
    assert.equal(contexts.length, 0, 'nothing to install into yet')

    provide('systemPrompt', makeSystemPrompt(contexts))
    assert.equal(contexts.length, 1, 'the deferred install must fire')
  })
})

test('cordis: a composition without systemPrompt still loads and reports why', async () => {
  await sandbox(async () => {
    const registered = new Map()
    const { ctx } = cordisLikeCtx({ services: { tools: makeTools(registered) } })

    await boot(ctx)

    // Every tool still works.
    assert.deepEqual([...registered.keys()].sort(), [
      'memory',
      'memory_audit',
      'memory_dream',
      'memory_note',
      'memory_status',
      'memory_wiki',
    ])

    const status = await registered.get('memory_status').execute({}, signal())
    assert.match(status.injection, /no systemPrompt service/)
  })
})

// ---------------------------------------------------------------- waterfall

test('cordis: the pre-step listener must not veto the waterfall', async () => {
  await sandbox(async () => {
    const registered = new Map()
    const contexts = []
    const { ctx, waterfall, hooks } = cordisLikeCtx({
      services: {
        systemPrompt: makeSystemPrompt(contexts),
        tools: makeTools(registered),
      },
    })

    await boot(ctx)

    // Assert the listener exists at all. Without this, the test passes on code
    // where injection never installed — the listener was never registered, so
    // there is nothing to veto with. That masking is how the bug survived.
    assert.equal(
      (hooks.get('agent/pre-step') ?? []).length,
      1,
      'the pre-step listener must be registered',
    )

    // The agent loop's own base callback returns the step decision. A listener
    // that forgets `next()` makes this undefined and breaks every turn.
    const decision = await waterfall(
      'agent/pre-step',
      { agent: 'a', messages: [], step: 1 },
      () => Promise.resolve({ kind: 'enter', messages: ['base'] }),
    )

    assert.deepEqual(
      decision,
      { kind: 'enter', messages: ['base'] },
      'the base callback must be reached',
    )
  })
})

test('cordis: the pre-step listener still refreshes the cache', async () => {
  await sandbox(async () => {
    const registered = new Map()
    const contexts = []
    const { ctx, waterfall } = cordisLikeCtx({
      services: {
        systemPrompt: makeSystemPrompt(contexts),
        tools: makeTools(registered),
      },
    })

    await boot(ctx)

    const contribution = contexts[0]
    await registered.get('memory').execute(
      { operations: [{ action: 'add', content: 'first fact' }] },
      signal(),
    )
    assert.match(contribution.text({}), /first fact/)

    // A write invalidates through `injectionInvalidate`, not the mtime path,
    // so the render must already reflect the new entry.
    await registered.get('memory').execute(
      { operations: [{ action: 'add', content: 'second fact' }] },
      signal(),
    )
    const text = contribution.text({})
    assert.match(text, /first fact/)
    assert.match(text, /second fact/)

    // The pre-step hook must run without disturbing the decision.
    const decision = await waterfall(
      'agent/pre-step',
      { agent: 'a', messages: [], step: 1 },
      () => Promise.resolve({ kind: 'enter', messages: [] }),
    )
    assert.equal(decision.kind, 'enter')
  })
})
