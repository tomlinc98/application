/**
 * World generation.
 *
 * @module
 */
import * as Sqrl from 'squirrelly';
import * as Autofill from './autofill';
import * as Simulator from './simulator';
import * as WindowManager from './window-manager';
import * as Engine from './engine';
import Tournament from '@liga/shared/tournament';
import DatabaseClient from './database-client';
import { addDays, addWeeks, addYears, format, setDay } from 'date-fns';
import { compact, differenceBy, flatten, groupBy, random, sample, shuffle } from 'lodash';
import { Calendar, Prisma } from '@prisma/client';
import { Constants, Dialogue, Chance, Bot, Eagers, Util } from '@liga/shared';

/**
 * Bumps the current season number by one.
 *
 * @function
 */
export async function bumpSeasonNumber() {
  const profile = await DatabaseClient.prisma.profile.findFirst();
  return DatabaseClient.prisma.profile.update({
    where: {
      id: profile.id,
    },
    data: {
      season: {
        increment: 1,
      },
    },
  });
}

/**
 * Creates competitions at the start of a new season.
 *
 * @function
 */
export async function createCompetitions() {
  // grab current profile
  const profile = await DatabaseClient.prisma.profile.findFirst<typeof Eagers.profile>();
  const today = profile?.date || new Date();

  // loop through autofill entries and create competitions
  const autofill = Autofill.Items.filter(
    (item) => item.on === Constants.CalendarEntry.SEASON_START,
  );
  const tiers = await DatabaseClient.prisma.tier.findMany({
    where: {
      slug: {
        in: autofill.map((item) => item.tierSlug),
      },
    },
    include: Eagers.tier.include,
  });

  return Promise.all(
    autofill.map(async (item) => {
      const tier = tiers.find((tier) => tier.slug === item.tierSlug);
      return Promise.all(
        tier.league.federations.map(async (federation) => {
          // collect teams and create the competition
          const teams = await Autofill.parse(item, tier, federation);
          const competition = await DatabaseClient.prisma.competition.create({
            data: {
              season: profile.season,
              federation: {
                connect: {
                  id: federation.id,
                },
              },
              tier: {
                connect: {
                  id: tier.id,
                },
              },
              competitors: {
                create: teams.map((team) => ({ teamId: team.id })),
              },
            },
            include: {
              tier: true,
            },
          });

          // bail early if this competition relies on
          // a trigger to schedule its start date
          if (competition.tier.triggerOffsetDays) {
            return Promise.resolve();
          }

          // create the calendar entry for when this competition starts
          Engine.Runtime.Instance.log.debug(
            'Scheduling start date for %s - %s...',
            federation.name,
            tier.name,
          );

          return DatabaseClient.prisma.calendar.create({
            data: {
              date: addDays(today, tier.league.startOffsetDays).toISOString(),
              type: Constants.CalendarEntry.COMPETITION_START,
              payload: competition.id.toString(),
            },
          });
        }),
      );
    }),
  );
}

/**
 * Creates matchdays.
 *
 * @param matches     The array of matches to create matchdays for.
 * @param tournament  The tournament object the matches belong to.
 * @param competition The competition the matches belong to.
 * @param mapName     The round's map name.
 * @function
 */
async function createMatchdays(
  matches: Clux.Match[],
  tournament: Tournament,
  competition: Prisma.CompetitionGetPayload<{
    include: { tier: { include: { league: true } }; competitors: true };
  }>,
  mapName?: string,
) {
  // grab current profile
  const profile = await DatabaseClient.prisma.profile.findFirst();
  const today = profile?.date || new Date();

  // grab user seed
  const userCompetitorId = competition.competitors.find(
    (competitor) => competitor.teamId === profile.teamId,
  );
  const userSeed = tournament.getSeedByCompetitorId(userCompetitorId?.id);

  // create the matchdays
  const totalRounds = tournament.$base.rounds().length;

  return Promise.all(
    matches.map(async (match) => {
      // build competitors list
      const competitors = compact(
        match.p.map(
          (seed) =>
            seed > 0 && {
              seed,
              teamId: competition.competitors.find(
                (competitor) => tournament.getCompetitorBySeed(seed) === competitor.id,
              ).teamId,
            },
        ),
      );

      // are both teams ready?
      let status: Constants.MatchStatus;

      switch (competitors.length) {
        case 0:
          status = Constants.MatchStatus.LOCKED;
          break;
        case 1:
          status = Constants.MatchStatus.WAITING;
          break;
        default:
          status = Constants.MatchStatus.READY;
          break;
      }

      // if one of the seeds is `-1` then this is
      // a BYE and the match will not be played
      if (match.p.includes(-1)) {
        status = Constants.MatchStatus.COMPLETED;
      }

      // if there's an existing matchday record then we only need
      // update its status and add competitors if necessary
      const existingMatch = await DatabaseClient.prisma.match.findFirst({
        where: {
          payload: JSON.stringify(match.id),
          competitionId: Number(competition.id),
        },
        include: {
          competitors: true,
        },
      });

      if (existingMatch) {
        const existingEntry = await DatabaseClient.prisma.calendar.findFirst({
          where: { payload: String(existingMatch.id) },
        });
        if (match.p.includes(userSeed)) {
          Engine.Runtime.Instance.log.debug(
            'User has new match(id=%d) on %s',
            existingEntry.id,
            format(existingEntry.date, Constants.Application.CALENDAR_DATE_FORMAT),
          );
        }
        return DatabaseClient.prisma.$transaction([
          DatabaseClient.prisma.calendar.update({
            where: { id: existingEntry.id },
            data: {
              type: match.p.includes(userSeed)
                ? Constants.CalendarEntry.MATCHDAY_USER
                : Constants.CalendarEntry.MATCHDAY_NPC,
            },
          }),
          DatabaseClient.prisma.match.update({
            where: { id: existingMatch.id },
            data: {
              status,
              competitors: {
                create: differenceBy(competitors, existingMatch.competitors, 'teamId'),
              },
            },
          }),
        ]);
      }

      // generate day of week for match
      const dayOfWeek = Chance.roll(Constants.MatchDayWeights[competition.tier.league.slug]);
      const week = addWeeks(today, match.id.r);
      const matchday = setDay(week, Number(dayOfWeek), { weekStartsOn: 1 });

      // assign map to match
      if (!match.data) {
        match.data = { map: mapName };
      } else {
        match.data['map'] = mapName;
      }

      // create match record
      const newMatch = await DatabaseClient.prisma.match.create({
        data: {
          status,
          totalRounds,
          round: match.id.r,
          date: matchday.toISOString(),
          payload: JSON.stringify(match.id),
          competition: {
            connect: {
              id: competition.id,
            },
          },
          competitors: {
            create: competitors,
          },
          games: {
            create: [
              {
                status,
                map: mapName,
                num: 1,
                teams: {
                  create: competitors,
                },
              },
            ],
          },
        },
      });

      // don't schedule the match if it's already
      // been completed (e.g.: BYE week)
      if (status === Constants.MatchStatus.COMPLETED) {
        return Promise.resolve();
      }

      // register matchday in the calendar
      return DatabaseClient.prisma.calendar.create({
        data: {
          type: match.p.includes(userSeed)
            ? Constants.CalendarEntry.MATCHDAY_USER
            : Constants.CalendarEntry.MATCHDAY_NPC,
          date: matchday.toISOString(),
          payload: String(newMatch.id),
        },
      });
    }),
  );
}

/**
 * Sends a welcome e-mail to the user upon creating a new career.
 *
 * A new career is determined by comparing the current
 * year with the profile's current year.
 *
 * @function
 */
export async function createWelcomeEmail() {
  const profile = await DatabaseClient.prisma.profile.findFirst(Eagers.profile);

  if (new Date().getFullYear() === profile.date.getFullYear()) {
    const [persona] = profile.team.personas;
    await sendEmail(
      Dialogue.WelcomeEmail.SUBJECT,
      Sqrl.render(Dialogue.WelcomeEmail.CONTENT, {
        profile,
        persona,
      }),
      persona,
      profile.date,
      false,
    );
  }

  return Promise.resolve();
}

/**
 * Parses a transfer offer from the player's perspective.
 *
 * @param transfer The transfer offer to parse.
 * @function
 */
function parsePlayerTransferOffer(transfer: Prisma.TransferGetPayload<typeof Eagers.transfer>): {
  dialogue: Partial<Prisma.DialogueGetPayload<{ include: { from: true } }>>;
  transfer: Partial<Prisma.TransferGetPayload<typeof Eagers.transfer>>;
  paperwork?: Array<Promise<unknown>>;
} {
  // get most recent offer
  const [offer] = transfer.offers;

  // who will be sending the response e-mail
  const persona = transfer.to.personas.find(
    (persona) =>
      persona.role === Constants.PersonaRole.MANAGER ||
      persona.role === Constants.PersonaRole.ASSISTANT,
  );

  // roll if player is willing to accept lowball offer
  if (
    offer.wages < transfer.target.wages &&
    !Chance.rollD2(Constants.TransferSettings.PBX_PLAYER_LOWBALL_OFFER)
  ) {
    Engine.Runtime.Instance.log.info(
      '%s rejected offer. Reason: Lowball offer.',
      transfer.target.name,
    );
    return {
      transfer: {
        status: Constants.TransferStatus.PLAYER_REJECTED,
      },
      dialogue: {
        from: persona,
        content: Dialogue.OfferRejectedEmailWages.CONTENT,
      },
    };
  }

  // roll if player is willing to relocate
  if (
    transfer.from.country.continentId !== transfer.target.country.continentId &&
    !Chance.rollD2(Constants.TransferSettings.PBX_PLAYER_RELOCATE)
  ) {
    Engine.Runtime.Instance.log.info(
      '%s rejected offer. Reason: Not willing to relocate.',
      transfer.target.name,
    );
    return {
      transfer: {
        status: Constants.TransferStatus.PLAYER_REJECTED,
      },
      dialogue: {
        from: persona,
        content: Dialogue.OfferRejectedEmailRelocate.CONTENT,
      },
    };
  }

  // got this far -- offer accepted!
  Engine.Runtime.Instance.log.info('%s has accepted the offer.', transfer.target.name);
  return {
    transfer: {
      status: Constants.TransferStatus.PLAYER_ACCEPTED,
    },
    dialogue: {
      from: persona,
      content: Dialogue.OfferAcceptedPlayer.CONTENT,
    },
    paperwork: [
      DatabaseClient.prisma.player.update({
        where: { id: transfer.target.id },
        data: {
          team: {
            connect: {
              id: transfer.from.id,
            },
          },
        },
      }),
      DatabaseClient.prisma.transfer
        .findMany({
          where: {
            id: {
              not: transfer.id,
            },
            target: {
              id: transfer.target.id,
            },
          },
        })
        .then((transfers) =>
          Promise.all([
            DatabaseClient.prisma.transfer.updateMany({
              where: {
                id: {
                  in: transfers.map((otherTransfer) => otherTransfer.id),
                },
              },
              data: {
                status: Constants.TransferStatus.PLAYER_REJECTED,
              },
            }),
            DatabaseClient.prisma.offer.updateMany({
              where: {
                transferId: {
                  in: transfers.map((otherTransfer) => otherTransfer.id),
                },
              },
              data: {
                status: Constants.TransferStatus.PLAYER_REJECTED,
              },
            }),
          ]),
        ),
    ],
  };
}

/**
 * Parses a transfer offer from the team's perspective.
 *
 * @param transfer  The transfer offer to parse.
 * @param profile   The active user profile.
 * @param status    Force accepts or rejects the transfer.
 * @function
 */
export function parseTeamTransferOffer(
  transfer: Prisma.TransferGetPayload<typeof Eagers.transfer>,
  profile: Prisma.ProfileGetPayload<unknown>,
  status?: Constants.TransferStatus,
): ReturnType<typeof parsePlayerTransferOffer> {
  // get most recent offer
  const [offer] = transfer.offers;

  // who will be sending the response e-mail
  const persona = transfer.to.personas.find(
    (persona) =>
      persona.role === Constants.PersonaRole.MANAGER ||
      persona.role === Constants.PersonaRole.ASSISTANT,
  );

  // action items that must happen when an offer is accepted
  const paperwork = () => [
    DatabaseClient.prisma.offer.create({
      data: {
        status: Constants.TransferStatus.PLAYER_PENDING,
        wages: offer.wages,
        cost: offer.cost,
        transfer: {
          connect: { id: transfer.id },
        },
      },
    }),
    DatabaseClient.prisma.calendar.create({
      data: {
        type: Constants.CalendarEntry.TRANSFER_PARSE,
        payload: String(transfer.id),
        date: addDays(
          profile.date,
          random(
            Constants.TransferSettings.RESPONSE_MIN_DAYS,
            Constants.TransferSettings.RESPONSE_MAX_DAYS,
          ),
        ).toISOString(),
      },
    }),
  ];

  // bail early if a transfer status was set
  if (typeof status === 'number') {
    const email =
      status === Constants.TransferStatus.TEAM_ACCEPTED
        ? Dialogue.OfferAcceptedUser
        : Dialogue.OfferRejectedUser;
    return {
      transfer: { status },
      dialogue: {
        from: persona,
        content: email.CONTENT,
      },
      paperwork: status === Constants.TransferStatus.TEAM_ACCEPTED && paperwork(),
    };
  }

  // bail early if the team lacks squad depth
  if (transfer.to.players.length <= Constants.Application.SQUAD_MIN_LENGTH) {
    Engine.Runtime.Instance.log.info(
      '%s rejected the offer. Reason: Lack of squad depth.',
      transfer.to.name,
    );
    return {
      transfer: {
        status: Constants.TransferStatus.TEAM_REJECTED,
      },
      dialogue: {
        from: persona,
        content: Dialogue.OfferRejectedEmailSquadDepth.CONTENT,
      },
    };
  }

  // roll if team is willing to accept a lowball offer
  if (
    offer.cost < transfer.target.cost &&
    !Chance.rollD2(Constants.TransferSettings.PBX_TEAM_LOWBALL_OFFER)
  ) {
    Engine.Runtime.Instance.log.info('%s rejected offer. Reason: Lowball offer.', transfer.to.name);
    return {
      transfer: {
        status: Constants.TransferStatus.TEAM_REJECTED,
      },
      dialogue: {
        from: persona,
        content: Dialogue.OfferRejectedEmailCost.CONTENT,
      },
    };
  }

  // roll if team is willing to sell an unlisted player
  //
  // note that the team is willing to consider selling
  // the unlisted player if the offer is good enough
  const modifier =
    Constants.TransferSettings.PBX_TEAM_SELL_UNLISTED *
    Constants.TransferSettings.PBX_TEAM_HIGHBALL_MODIFIER *
    Math.max(0, offer.cost - transfer.target.cost);

  if (
    !transfer.target.transferListed &&
    !Chance.rollD2(Math.floor(Constants.TransferSettings.PBX_TEAM_SELL_UNLISTED + modifier))
  ) {
    Engine.Runtime.Instance.log.info('%s rejected offer. Reason: Not for sale.', transfer.to.name);
    return {
      transfer: {
        status: Constants.TransferStatus.TEAM_REJECTED,
      },
      dialogue: {
        from: persona,
        content: Dialogue.OfferRejectedEmailUnlisted.CONTENT,
      },
    };
  }

  // got this far -- offer accepted!
  Engine.Runtime.Instance.log.info('%s has accepted the offer.', transfer.to.name);
  return {
    transfer: {
      status: Constants.TransferStatus.TEAM_ACCEPTED,
    },
    dialogue: {
      from: persona,
      content: Dialogue.OfferAcceptedTeam.CONTENT,
    },
    paperwork: paperwork(),
  };
}

/**
 * Records the match results for the day by updating
 * their respective tournament object entries.
 *
 * Also checks whether any competitions are set to start
 * after the completion of a dependent competition and
 * creates their calendar entry database record.
 *
 * @function
 */
export async function recordMatchResults() {
  // get today's match results
  const profile = await DatabaseClient.prisma.profile.findFirst<typeof Eagers.profile>();
  const today = profile?.date || new Date();
  const allMatches = await DatabaseClient.prisma.match.findMany({
    where: {
      date: today.toISOString(),
      status: Constants.MatchStatus.COMPLETED,
    },
    include: {
      competitors: true,
      competition: {
        include: {
          competitors: true,
          tier: { include: { league: true } },
          federation: true,
        },
      },
    },
  });

  // group them together by competition id
  const groupedMatches = groupBy(allMatches, 'competitionId');
  const competitionIds = Object.keys(groupedMatches);

  // record results for all competitions
  return Promise.all(
    competitionIds.map(async (competitionId) => {
      // restore tournament object
      const matches = groupedMatches[competitionId];
      const competition = matches[0].competition;
      const tournamentData = JSON.parse(competition.tournament);
      const tournament = Tournament.restore(tournamentData as ReturnType<Tournament['save']>);

      // record match results with tourney
      matches.forEach((match) => {
        const cluxMatch = tournament.$base.findMatch(JSON.parse(match.payload));

        // skip if this match is a BYE
        if (cluxMatch.p.includes(-1)) {
          return;
        }

        // get home and away scores based off of their seeds since
        // the competitors array is not in the correct order
        const [home, away] = cluxMatch.p;
        const homeScore = match.competitors.find((competitor) => home === competitor.seed);
        const awayScore = match.competitors.find((competitor) => away === competitor.seed);

        // record the score
        tournament.$base.score(cluxMatch.id, [homeScore.score, awayScore.score]);
      });

      // check if a new cup round must be generated
      //
      // this is done by checking if all
      // matches have not been scored
      const newMatches = tournament.$base.currentRound(Constants.BracketIdentifier.UPPER);
      const newRound = Array.isArray(newMatches) && newMatches.every((match) => !match.m);

      if (tournament.brackets && newRound) {
        Engine.Runtime.Instance.log.info('Generating next round of matches...');
        await createMatchdays(newMatches, tournament, competition);
      }

      // check if competition is done and a start date must
      // be scheduled for a dependent competition
      if (tournament.$base.isDone() && competition.tier.triggerTierSlug) {
        const triggeredCompetition = await DatabaseClient.prisma.competition.findFirst({
          where: {
            season: competition.season,
            tier: {
              slug: competition.tier.triggerTierSlug,
            },
            federation: {
              OR: [
                { slug: competition.federation.slug },
                { slug: Constants.FederationSlug.ESPORTS_WORLD },
              ],
            },
          },
          include: {
            federation: true,
            tier: true,
          },
        });
        const date = addDays(today, triggeredCompetition.tier.triggerOffsetDays);

        // bail if entry already exists
        const existingEntry = await DatabaseClient.prisma.calendar.findFirst({
          where: {
            date: {
              gte: today.toISOString(),
              lte: date.toISOString(),
            },
            type: Constants.CalendarEntry.COMPETITION_START,
            payload: triggeredCompetition.id.toString(),
          },
        });

        if (existingEntry) {
          return Promise.resolve();
        }

        Engine.Runtime.Instance.log.debug(
          'Scheduling start date for %s on %s...',
          triggeredCompetition.tier.name,
          format(date, Constants.Application.CALENDAR_DATE_FORMAT),
        );

        try {
          await DatabaseClient.prisma.calendar.create({
            data: {
              date: date.toISOString(),
              type: Constants.CalendarEntry.COMPETITION_START,
              payload: triggeredCompetition.id.toString(),
            },
          });
        } catch (e) {
          Engine.Runtime.Instance.log.warn(
            'Existing start date for %s found. Skipping...',
            triggeredCompetition.tier.name,
          );
        }
      }

      // check if user won any awards
      await sendUserAward(competition, tournament);

      // update the competition database record
      return DatabaseClient.prisma.competition.update({
        where: { id: Number(competitionId) },
        data: {
          tournament: JSON.stringify(tournament.save()),
          competitors: {
            update: tournament.competitors.map((id) => {
              const competitor = tournament.$base.resultsFor(tournament.getSeedByCompetitorId(id));
              return {
                where: { id },
                data: {
                  position: competitor.gpos || competitor.pos,
                  win: competitor.wins,
                  loss: competitor.losses,
                  draw: competitor.draws,
                },
              };
            }),
          },
        },
      });
    }),
  );
}

/**
 * Resets the player training gains at the end of the season.
 *
 * @function
 */
async function resetTrainingGains() {
  return DatabaseClient.prisma.player.updateMany({
    data: {
      gains: null,
    },
  });
}

/**
 * Creates a calendar entry to start
 * the next season a year from today.
 *
 * @function
 */
export async function scheduleNextSeasonStart() {
  const profile = await DatabaseClient.prisma.profile.findFirst();
  return DatabaseClient.prisma.calendar.create({
    data: {
      date: addYears(profile.date, 1).toISOString(),
      type: Constants.CalendarEntry.SEASON_START,
    },
  });
}

/**
 * Sends an e-mail to the user and notifies the main
 * window process to render a toast notification.
 *
 * @param subject   The subject.
 * @param content   The content.
 * @param persona   The persona.
 * @param sentAt    The sent at date.
 * @param notify    Notify the main window.
 * @function
 */
async function sendEmail(
  subject: string,
  content: string,
  persona: Prisma.PersonaGetPayload<unknown>,
  sentAt: Date,
  notify = true,
) {
  const dialogues: Prisma.EmailUpsertArgs['create']['dialogues'] = {
    create: {
      sentAt,
      content,
      from: {
        connect: { id: persona.id },
      },
    },
  };
  const email = await DatabaseClient.prisma.email.upsert({
    where: { subject },
    update: {
      dialogues,
      read: false,
    },
    create: {
      subject,
      dialogues,
      sentAt,
      from: {
        connect: {
          id: persona.id,
        },
      },
    },
    include: Eagers.email.include,
  });

  // let the renderer know a new e-mail came in
  if (notify) {
    const mainWindow = WindowManager.get(Constants.WindowIdentifier.Main).webContents;
    mainWindow.send(Constants.IPCRoute.EMAILS_NEW, email);
  }

  return Promise.resolve(email);
}

/**
 * Determine whether to send the user an award.
 *
 * @param competition         The competition database record.
 * @param preloadedTournament Tournament instance, if already loaded.
 * @function
 */
export async function sendUserAward(
  competition: Prisma.CompetitionGetPayload<{ include: { competitors: true; tier: true } }>,
  preloadedTournament?: Tournament,
) {
  // bail if competition is not done yet
  const profile = await DatabaseClient.prisma.profile.findFirst<typeof Eagers.profile>();
  const tournament = preloadedTournament || Tournament.restore(JSON.parse(competition.tournament));

  if (!tournament.$base.isDone()) {
    return Promise.resolve();
  }

  // check if user is participating in competition
  const userCompetitorId = competition.competitors.find(
    (competitor) => competitor.teamId === profile.teamId,
  );
  const userSeed = tournament.getSeedByCompetitorId(userCompetitorId?.id);

  if (!userSeed) {
    return Promise.resolve();
  }

  // check if competition has any awards
  const awards = Constants.Awards.filter(
    (award) =>
      award.target === competition.tier.slug &&
      award.on === Constants.CalendarEntry.COMPETITION_END,
  );

  if (!awards.length) {
    return Promise.resolve();
  }

  // now check if user placed
  const result = tournament.$base.resultsFor(userSeed);
  const position = result.gpos || result.pos;
  const [award] = awards.filter((award) =>
    !award.end ? position === award.start : position > award.start && position <= award.end,
  );

  if (!award || !award.action) {
    return Promise.resolve();
  }

  // figure out the type of e-mail to send
  let email: (typeof Dialogue)[keyof typeof Dialogue];

  switch (award.type) {
    case Constants.AwardType.CHAMPION:
      email = Dialogue.AwardTypeChampion;
      break;
    case Constants.AwardType.PROMOTION:
      email = Dialogue.AwardTypePromotion;
      break;
    case Constants.AwardType.QUALIFY:
      email = Dialogue.AwardTypeQualify;
      break;
    default:
      Engine.Runtime.Instance.log.warn('Award type %s not implemented.', award.type);
      break;
  }

  // run the actions (email, confetti, etc)
  return Promise.all(
    award.action.map((action) => {
      switch (action) {
        case Constants.AwardAction.EMAIL:
          return sendEmail(
            Sqrl.render(email.SUBJECT, { profile }),
            Sqrl.render(email.CONTENT, {
              profile,
              competition: Constants.IdiomaticTier[competition.tier.slug],
            }),
            profile.team.personas[0],
            profile.date,
          );
        case Constants.AwardAction.CONFETTI:
          WindowManager.get(Constants.WindowIdentifier.Main).webContents?.send(
            Constants.IPCRoute.CONFETTI_START,
          );
          return Promise.resolve();
        default:
          return Promise.resolve();
      }
    }),
  );
}

/**
 * Determine whether to send an offer to the user or not.
 *
 * @function
 */
export async function sendUserTransferOffer() {
  // bail early if user does not have any players to spare
  const profile = await DatabaseClient.prisma.profile.findFirst(Eagers.profile);
  const to = await DatabaseClient.prisma.team.findFirst({
    where: { id: profile.teamId },
    include: { players: true, personas: true },
  });

  if (to.players.length <= Constants.Application.SQUAD_MIN_LENGTH) {
    return Promise.resolve();
  }

  // roll if we're sending an offer today
  if (!Chance.rollD2(Constants.TransferSettings.PBX_USER_CONSIDER)) {
    return Promise.resolve();
  }

  // roll whether we continue if the user has no transfer listed players
  if (
    !to.players.some((player) => player.transferListed) &&
    !Chance.rollD2(Constants.TransferSettings.PBX_USER_SELL_UNLISTED)
  ) {
    return Promise.resolve();
  }

  // sort players by exp and pluck our target at random
  const targets = to.players
    .filter((player) => player.id !== profile.playerId)
    .sort(
      (a, b) => Bot.Exp.getTotalXP(JSON.parse(b.stats)) - Bot.Exp.getTotalXP(JSON.parse(a.stats)),
    );
  const target = Chance.pluck(targets, Constants.TransferSettings.PBX_USER_TARGET);

  // figure out what prestige level to fetch a buyer from
  const [prestigeHigh, prestigeSame, prestigeLow] =
    Constants.TransferSettings.PBX_USER_PRESTIGE_WEIGHTS;
  const pbxPrestige = Constants.Prestige.map((_, idx) =>
    idx > to.prestige ? prestigeHigh : idx === to.prestige ? prestigeSame : prestigeLow,
  );
  const prestige = Chance.pluck(Constants.Prestige, pbxPrestige);
  const teams = await DatabaseClient.prisma.team.findMany({
    where: {
      prestige: Constants.Prestige.findIndex((prestigex) => prestigex === prestige),
      id: { not: profile.team.id },
    },
    include: { personas: true },
  });
  const from = sample(teams);

  // create transfer offer
  const transfer = await DatabaseClient.prisma.transfer.create({
    data: {
      status: Constants.TransferStatus.TEAM_PENDING,
      from: {
        connect: { id: from.id },
      },
      to: {
        connect: { id: to.id },
      },
      target: {
        connect: { id: target.id },
      },
      offers: {
        create: [
          {
            status: Constants.TransferStatus.TEAM_PENDING,
            cost: random(0, target.cost),
            wages: random(0, target.wages),
          },
        ],
      },
    },
    include: Eagers.transfer.include,
  });

  // send e-mail
  await sendEmail(
    Sqrl.render(Dialogue.OfferIncoming.SUBJECT, { transfer }),
    Sqrl.render(Dialogue.OfferIncoming.CONTENT, { transfer, profile }),
    from.personas.find((persona) => persona.role === Constants.PersonaRole.MANAGER),
    profile.date,
  );

  // wrap it up
  Engine.Runtime.Instance.log.info(
    '%s (prestige: %d) sent an offer to %s for %s',
    from.name,
    from.prestige,
    to.name,
    target.name,
  );
  return Promise.resolve();
}

/**
 * Sync teams to their current tier.
 *
 * By the time this function runs, the new season's league
 * competitions should have already been started and the
 * teams placed in their corresponding tier.
 *
 * @function
 */
export async function syncTiers() {
  // get the current season's league competitions
  const profile = await DatabaseClient.prisma.profile.findFirst();
  const competitions = await DatabaseClient.prisma.competition.findMany({
    where: {
      season: profile.season,
      tier: {
        league: {
          slug: Constants.LeagueSlug.ESPORTS_LEAGUE,
        },
      },
    },
    include: {
      competitors: true,
      tier: true,
    },
  });

  // build a transaction for all the updates
  const transaction = competitions.map((competition) =>
    DatabaseClient.prisma.team.updateMany({
      where: {
        id: { in: competition.competitors.map((competitor) => competitor.teamId) },
      },
      data: {
        tier: Constants.Prestige.findIndex((prestige) => prestige === competition.tier.slug),
      },
    }),
  );

  // run the transaction
  return DatabaseClient.prisma.$transaction(transaction);
}

/**
 * Sync player wages.
 *
 * Currently, only the user's players can gain XP throughout the season
 * but this may change in the future. At which point this function
 * would be a mirror of the `061-wages.ts` seeder.
 *
 * @todo move the transaction logic to a shared function
 * @function
 */
export async function syncWages() {
  // get the user's squad
  const profile = await DatabaseClient.prisma.profile.findFirst<typeof Eagers.profile>();

  // build a transaction for all the updates
  const transaction = profile.team.players.map((player) => {
    const xp = new Bot.Exp(JSON.parse(player.stats));
    const tier = Constants.Prestige[xp.getBotTemplate().prestige];
    const wageConfigs = Constants.PlayerWages[tier as keyof typeof Constants.PlayerWages];

    if (!wageConfigs) {
      return DatabaseClient.prisma.player.update({
        where: { id: player.id },
        data: { cost: 0, wages: 0 },
      });
    }

    // build probability weights
    const wagePbxWeight = {} as Parameters<typeof Chance.roll>[number];
    wageConfigs.forEach((weight, idx) => (wagePbxWeight[idx] = weight.percent));

    // pick the wage range for the player
    const wageConfigIdx = Chance.roll(wagePbxWeight);
    const wageConfig = wageConfigs[Number(wageConfigIdx)];

    // calculate cost from wage
    const wages = random(wageConfig.low, wageConfig.high);
    const cost = wages * wageConfig.multiplier;

    return DatabaseClient.prisma.player.update({
      where: { id: player.id },
      data: { cost, wages },
    });
  });

  // run the transaction
  return DatabaseClient.prisma.$transaction(transaction);
}

/**
 * Engine loop handler.
 *
 * Starts the provided competition.
 *
 * @param entry Engine loop input data.
 * @function
 */
export async function onCompetitionStart(entry: Calendar) {
  // find the competition for this calendar entry item
  let competition = await DatabaseClient.prisma.competition.findFirst({
    where: {
      id: parseInt(entry.payload),
    },
    include: Eagers.competition.include,
  });

  Engine.Runtime.Instance.log.debug('Starting %s...', competition.tier.name);

  // if autofill was triggered then we must reload the competition
  // model with the updated competitor relationships
  const autofill = Autofill.Items.filter(
    (item) =>
      item.on === Constants.CalendarEntry.COMPETITION_START &&
      item.tierSlug === competition.tier.slug,
  );
  const tiers = await DatabaseClient.prisma.tier.findMany({
    where: {
      slug: competition.tier.slug,
    },
    include: Eagers.tier.include,
  });
  const teams = flatten(
    await Promise.all(
      autofill.map(async (item) => {
        const tier = tiers.find((tier) => tier.slug === item.tierSlug);
        return Autofill.parse(item, tier, competition.federation);
      }),
    ),
  );

  if (teams.length > 0) {
    competition = await DatabaseClient.prisma.competition.update({
      where: { id: competition.id },
      data: {
        competitors: {
          create: teams.map((team) => ({ teamId: team.id })),
        },
      },
      include: Eagers.competition.include,
    });
  }

  // create and start the tournament
  const tournament = new Tournament(competition.tier.size, {
    groupSize: competition.tier.groupSize,
    meetTwice: false,
    short: true,
  });
  tournament.addCompetitors(shuffle(competition.competitors).map((competitor) => competitor.id));
  tournament.start();

  // register matches
  await Promise.all(
    tournament.$base.rounds().map((round) => {
      return createMatchdays(round, tournament, competition, sample(Constants.MapPool));
    }),
  );

  // grab last match day to record competition end day
  const lastMatchDay = await DatabaseClient.prisma.match.findFirst({
    where: {
      competitionId: competition.id,
    },
    orderBy: {
      date: 'desc',
    },
  });

  await DatabaseClient.prisma.calendar.create({
    data: {
      date: lastMatchDay.date,
      type: Constants.CalendarEntry.COMPETITION_END,
      payload: competition.id.toString(),
    },
  });

  // update the competition database record
  return DatabaseClient.prisma.competition.update({
    where: { id: competition.id },
    data: {
      started: true,
      tournament: JSON.stringify(tournament.save()),
      competitors: {
        update: tournament.competitors.map((id) => ({
          where: { id },
          data: {
            seed: tournament.getSeedByCompetitorId(id),
            group: tournament.getGroupByCompetitorId(id),
          },
        })),
      },
    },
  });
}

/**
 * Engine loop handler.
 *
 * Runs all actionable items that are required
 * when starting a new season.
 *
 * @function
 */
export async function onSeasonStart() {
  Engine.Runtime.Instance.log.info('Starting the season...');
  return createWelcomeEmail()
    .then(scheduleNextSeasonStart)
    .then(bumpSeasonNumber)
    .then(createCompetitions)
    .then(resetTrainingGains)
    .then(syncTiers)
    .then(syncWages);
}

/**
 * Engine loop handler.
 *
 * Simulates an NPC match.
 *
 * @param entry Engine loop input data.
 * @function
 */
export async function onMatchdayNPC(entry: Calendar) {
  const match = await DatabaseClient.prisma.match.findFirst({
    where: {
      id: Number(entry.payload),
    },
    include: {
      competitors: {
        include: {
          team: { include: { players: true } },
        },
      },
      competition: {
        include: {
          tier: true,
        },
      },
    },
  });

  if (entry.type === Constants.CalendarEntry.MATCHDAY_USER) {
    Engine.Runtime.Instance.log.debug('Found match(id=%d) with status: %s', match.id, match.status);
  }

  if (match.status !== Constants.MatchStatus.READY) {
    Engine.Runtime.Instance.log.warn(
      'Cannot simulate match. Invalid match state: %s. Skipping.',
      match.status,
    );
    return Promise.resolve();
  }

  // load sim settings if this is a user matchday
  const simulationSettings = {} as Partial<Parameters<typeof Simulator.score>['1']>;

  if (entry.type === Constants.CalendarEntry.MATCHDAY_USER) {
    const profile = await DatabaseClient.prisma.profile.findFirst();
    const settings = Util.loadSettings(profile.settings);
    simulationSettings.userTeamId = profile.teamId;
    simulationSettings.mode = settings.general.simulationMode;
  }

  // are draws allowed?
  if (!match.competition.tier.groupSize) {
    simulationSettings.allowDraw = false;
  }

  // sim the game
  const [home, away] = match.competitors;
  const simulationResult = Simulator.score([home.team, away.team], simulationSettings);

  // check if we need to award earnings to user for a win
  if (
    entry.type === Constants.CalendarEntry.MATCHDAY_USER &&
    Simulator.getMatchResult(simulationSettings.userTeamId, simulationResult) ===
      Constants.MatchResult.WIN
  ) {
    const profile = await DatabaseClient.prisma.profile.findFirst();
    await DatabaseClient.prisma.team.update({
      where: {
        id: profile.teamId,
      },
      data: {
        earnings: {
          increment: Constants.GameSettings.WIN_AWARD_AMOUNT,
        },
      },
    });
  }

  return DatabaseClient.prisma.match.update({
    where: {
      id: Number(entry.payload),
    },
    data: {
      status: Constants.MatchStatus.COMPLETED,
      competitors: {
        update: match.competitors.map((competitor) => ({
          where: { id: competitor.id },
          data: {
            score: simulationResult[competitor.team.id],
            result: Simulator.getMatchResult(competitor.team.id, simulationResult),
          },
        })),
      },
    },
  });
}

/**
 * Engine loop handler.
 *
 * Stops the engine loop when the user has a
 * match to play and lets the renderer know.
 *
 * @param entry Engine loop input data.
 * @function
 */
export async function onMatchdayUser(entry: Calendar) {
  // load user settings
  const profile = await DatabaseClient.prisma.profile.findFirst();
  const settings = Util.loadSettings(profile.settings);

  // skip if this match has already been played
  const match = await DatabaseClient.prisma.match.findFirst({
    where: {
      id: Number(entry.payload),
    },
  });

  if (match.status === Constants.MatchStatus.COMPLETED) {
    return Promise.resolve();
  }

  // if engine loop terminate signals are
  // being skipped we must sim it now
  if (settings.calendar.ignoreExits) {
    return onMatchdayNPC(entry);
  }

  // otherwise stop the engine loop
  Engine.Runtime.Instance.log.info(
    'User matchday detected on %s. Stopping engine loop...',
    format(entry.date, Constants.Application.CALENDAR_DATE_FORMAT),
  );

  return Promise.resolve(false);
}

/**
 * Engine loop handler.
 *
 * Parses a transfer offer.
 *
 * @param entry Engine loop input data.
 * @function
 */
export async function onTransferOffer(entry: Partial<Calendar>) {
  // parse payload
  const [transferId, transferStatus] = isNaN(Number(entry.payload))
    ? JSON.parse(entry.payload)
    : [Number(entry.payload)];

  // grab latest offer
  const profile = await DatabaseClient.prisma.profile.findFirst(Eagers.profile);
  const transfer = await DatabaseClient.prisma.transfer.findFirst({
    where: {
      id: transferId,
    },
    include: {
      ...Eagers.transfer.include,
      offers: { orderBy: { id: 'desc' } },
    },
  });
  const [offer] = transfer.offers;

  // who's parsing the offer?
  let result: ReturnType<typeof parsePlayerTransferOffer>;

  switch (offer.status) {
    case Constants.TransferStatus.TEAM_PENDING:
      result = parseTeamTransferOffer(transfer, profile, transferStatus);
      break;
    case Constants.TransferStatus.PLAYER_PENDING:
      result = parsePlayerTransferOffer(transfer);
      break;
    default:
      return Promise.resolve();
  }

  // handle additional paperwork to finalize transfer offer
  if (result.paperwork) {
    await Promise.all(result.paperwork);
  }

  // update existing transfer and current offer
  await DatabaseClient.prisma.transfer.update({
    where: { id: transfer.id },
    data: {
      status: result.transfer.status,
      offers: {
        update: {
          where: { id: offer.id },
          data: {
            status: result.transfer.status,
          },
        },
      },
    },
  });

  // send response e-mail
  const email = await sendEmail(
    Sqrl.render(Dialogue.OfferGeneric.SUBJECT, { transfer }),
    Sqrl.render(result.dialogue.content, { transfer, profile }),
    result.dialogue.from,
    profile.date,
  );

  // update existing dialogues attached to this transfer
  // and toggle their action as completed
  await DatabaseClient.prisma.dialogue.updateMany({
    where: {
      emailId: email.id,
    },
    data: {
      completed: true,
    },
  });

  // unless the player accepted, we have nothing else to do
  if (result.transfer.status !== Constants.TransferStatus.PLAYER_ACCEPTED) {
    return Promise.resolve();
  }

  // update user earnings
  return Promise.all([
    DatabaseClient.prisma.team.update({
      where: {
        id: transfer.from.id,
      },
      data: {
        earnings: {
          decrement: offer.cost,
        },
      },
    }),
    DatabaseClient.prisma.team.update({
      where: {
        id: transfer.to.id,
      },
      data: {
        earnings: {
          increment: offer.cost,
        },
      },
    }),
  ]);
}