import { CanActivate, Injectable } from '@nestjs/common';

/**
 * AuthGuard no-op. Auth está fora de escopo do desafio (seção 2).
 * Em produção, este guard validaria JWT/sessão via IdP externo (Keycloak/Zitadel)
 * e extrairia providerId/playerId do token.
 * Ver ARCHITECTURE.md para o desenho proposto.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
