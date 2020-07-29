import Competitor from './competitor';


export interface Result {
  pos: number;
  seed: number;
}


export interface Match {
  id: { s: number; r: number; m: number };
  p: [ number, number ];
}


export interface Tournament {
  isDone: () => boolean;
  matches: Match[];
  matchesFor: ( seed: number ) => Match[];
  results: () => Result[];
  resultsFor: ( seed: number ) => Result;
  score: ( matchId: object, mapScore: any[] ) => boolean;
  standings?: Result[];
  state: any[];
  unscorable: ( matchId: object, mapScore: any[], allowPast?: boolean ) => string | null;
  upcoming: ( seed: number ) => Match[];
}


export interface Conference {
  id: string;
  competitors: Competitor[];
  groupObj: Tournament;
}


export interface PromotionConference {
  id: string;
  competitors: Competitor[];
  duelObj: Tournament;
}
