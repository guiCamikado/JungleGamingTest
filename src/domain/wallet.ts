import { Money, CurrencyMismatchError } from './money';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class NegativeBalanceError extends Error {
  constructor() {
    super('Wallet balance cannot be negative');
    this.name = 'NegativeBalanceError';
  }
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    if (props.initialBalance.isNegative()) throw new NegativeBalanceError();
    const now = new Date();
    return new Wallet(
      props.id, props.playerId, props.initialBalance.currency,
      props.initialBalance, 1, now, now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id, state.playerId, state.currency, state.balance,
      state.version, state.createdAt, state.updatedAt,
    );
  }

  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get updatedAt(): Date { return this._updatedAt; }

  debit(amount: Money, at: Date = new Date()): void {
    this.assertSameCurrency(amount);
    const next = this._balance.subtract(amount);
    if (next.isNegative()) throw new NegativeBalanceError();
    this._balance = next;
    this._version += 1;
    this._updatedAt = at;
  }

  credit(amount: Money, at: Date = new Date()): void {
    this.assertSameCurrency(amount);
    const next = this._balance.add(amount);
    if (next.isNegative()) throw new NegativeBalanceError();
    this._balance = next;
    this._version += 1;
    this._updatedAt = at;
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
