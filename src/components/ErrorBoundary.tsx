import { Component, type ErrorInfo, type ReactNode } from 'react';
import { captureError } from '../lib/telemetry';

interface Props {
  children: ReactNode;
  /** Rótulo pra telemetria (ex: nome da tela). */
  scope?: string;
}
interface State {
  hasError: boolean;
}

/**
 * Captura erros de render da subárvore e mostra um fallback em vez de derrubar
 * o app inteiro pra tela branca. Encaminha o erro pro funil de telemetria.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    captureError(error, { scope: this.props.scope ?? 'ErrorBoundary', componentStack: info.componentStack });
  }

  handleReload = () => {
    this.setState({ hasError: false });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center">
          <div className="w-14 h-14 rounded-2xl bg-rose-100 text-rose-600 flex items-center justify-center text-2xl font-black mb-4">!</div>
          <h2 className="text-lg font-black text-slate-900">Algo deu errado nesta tela</h2>
          <p className="text-[13px] font-medium text-slate-500 mt-1 max-w-md">
            Ocorreu um erro ao renderizar. Você pode recarregar — seus dados em cache não são perdidos.
          </p>
          <button
            onClick={this.handleReload}
            className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-white rounded-xl text-[12px] font-black uppercase tracking-wider hover:bg-primary/90 transition-colors"
          >
            Recarregar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
