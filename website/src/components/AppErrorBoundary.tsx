import { Component, type ErrorInfo, type ReactNode } from 'react'

type AppErrorBoundaryProps = {
  children: ReactNode
}

type AppErrorBoundaryState = {
  failed: boolean
}

export default class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('NuvemFund failed to initialize.', error, info)
  }

  render() {
    if (!this.state.failed) return this.props.children

    return (
      <main className="min-h-screen bg-[#0d1b24] px-6 text-white flex items-center justify-center">
        <section className="w-full max-w-md rounded-3xl border border-white/15 bg-black/30 p-8 text-center backdrop-blur-xl">
          <img src="/logo.png" alt="NuvemFund" className="mx-auto mb-6 h-10 w-auto" />
          <h1 className="text-2xl font-medium tracking-tight">We could not start NuvemFund</h1>
          <p className="mt-3 text-sm leading-relaxed text-white/65">
            Reload the page to try again. If the problem continues, the service may be temporarily unavailable.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-7 cursor-pointer rounded-full bg-white px-6 py-3 text-sm font-medium text-gray-900 transition-transform hover:scale-[1.03] active:scale-[0.97]"
          >
            Reload page
          </button>
        </section>
      </main>
    )
  }
}
