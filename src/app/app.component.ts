import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Component, computed, signal, Signal, WritableSignal } from '@angular/core';
import {
  FormArray,
  FormControl,
  FormGroup,
  UntypedFormBuilder,
  UntypedFormGroup
} from '@angular/forms';
import { filter, forkJoin, map, take } from 'rxjs';
import { cloneDeep, result } from 'lodash';
import { GameStats, PlayerData, PlayerTeam, PokemonData } from './core/interfaces';
import { GameData } from './core/interfaces/game-data.interface';

export function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent {
  formItem: UntypedFormGroup;

  constructor(private formBuilder: UntypedFormBuilder, private http: HttpClient) {
    this.formItem = this.formBuilder.group({
      gameurls: ''
    });

    this.formItem.get('gameurls')?.valueChanges.subscribe((gameUrls) => {
      let urls = gameUrls.split('\n');
      urls = urls.map((url: string) => {
        return url.split('/').pop()?.split('battle-').pop()
      });
      this.loadData(urls);
    });
  }

  title = 'pokemonshowdown-game-analyzer';
  selectedPlayer: WritableSignal<string> = signal('');
  selectedPokemon: WritableSignal<string> = signal('');
  loading: WritableSignal<boolean> = signal(false);

  players: WritableSignal<{ [player: string]: PlayerData } | null> = signal(null);
  pokemonList: WritableSignal<string[]> = signal([]);
  playerPokemons: Signal<string[] | null> = computed(() => {
    if (this.selectedPlayer() === '') return null;

    return Object.keys(this.players()![this.selectedPlayer()]['team']).filter(
      (key) => this.players()![this.selectedPlayer()]['team'][key].aliases[0] == key
    );
  });

  loadData(urls: string[]) {
    this.loading.set(true);
    const domParser = new DOMParser();

    // const apiCalls = urls.map(url =>
    //   this.http.get<any>(`/replay/${url}.log`, { responseType: "text" as "json" })
    // );

    const apiCalls = urls.map((url) =>
      this.http
        .get<any>(`/replay/${url}.log`, { responseType: 'text' as 'json' })
        .pipe(map((response) => ({ url, response })))
    );

    forkJoin(apiCalls)
      .pipe(take(1))
      .subscribe((games) => {
        games.forEach((data) => {
          this.initializeObjects(data.response, data.url);
        });
        this.loading.set(false);
      });
  }

  initializeObjects(data: string, gameUrl: string) {
    const battleLog: string[] = data.split('\n') ?? [];
    const p1name = battleLog.find((row) => row.includes('|player|p1'))?.split('|')[3] ?? undefined;
    const p2name = battleLog.find((row) => row.includes('|player|p2'))?.split('|')[3] ?? undefined;
    if (p1name === undefined || p2name === undefined) return;

    let p1pkmn:PlayerTeam | undefined = undefined;
    let p2pkmn:PlayerTeam | undefined = undefined;
    if (this.players() == null || this.players()![p1name] == undefined) {
      p1pkmn = battleLog
        .filter((row) => row.includes('|poke|p1'))
        .map((row) => row.split('|')[3])
        .reduce((acc: any, curr: string) => {
          acc[curr] = {
            aliases: [curr],
            turnsOnField: 0,
            kills: 0,
            supportMoves: 0,
            overallUtility: {}
          };
          return acc;
        }, {});
    }
    if (this.players() == null || this.players()![p2name] == undefined) {
      p2pkmn = battleLog
        .filter((row) => row.includes('|poke|p2'))
        .map((row) => row.split('|')[3])
        .reduce((acc: any, curr: string) => {
          acc[curr] = {
            aliases: [curr],
            turnsOnField: 0,
            kills: 0,
            supportMoves: 0,
            overallUtility: {}
          };
          return acc;
        }, {});
    }
    
    if (p1pkmn == undefined) {
      p1pkmn = this.players()![p1name]['team'];
    }
    if (p2pkmn == undefined) {
      p2pkmn = this.players()![p2name]['team'];
    }
    p1pkmn = this.elaboratePokemonData(p1pkmn, battleLog, gameUrl);
    p2pkmn = this.elaboratePokemonData(p2pkmn, battleLog, gameUrl);

    this.players.update((g) => {
      if (g === null) g = {};
      if (!!!g[p1name]) {
        g[p1name] = { team: {} };
        g[p1name]['team'] = p1pkmn;
      }
      if (!!!g[p2name]) {
        g[p2name] = { team: {} };
        g[p2name]['team'] = p2pkmn;
      }
      return g;
    });
    this.players.set(cloneDeep(this.players()));
  }

  elaboratePokemonData(pokemonTeam: PlayerTeam, battleLog: string[], gameUrl: string) {
    pokemonTeam = Object.fromEntries(
      Object.entries(pokemonTeam).map(([pkmnName, pkmnData]) => {
        return this.analyzeData(pkmnName, pkmnData, battleLog, gameUrl);
      })
    );
    Object.values(pokemonTeam).forEach((pkmnData: any) => {
      const surname = pkmnData['aliases'][1] as string;
      pokemonTeam[surname] = pkmnData;
    });
    return pokemonTeam;
  }

  analyzeData(pkmnName: string, pkmnData: PokemonData, battlelog: string[], gameUrl: string) {
    const pkmnSurname = battlelog
      .find((row) => row.includes('|switch|') && row.includes(pkmnName))
      ?.split('|')[2]
      .split(': ')[1];
    if (!!pkmnSurname) pkmnData['aliases'].push(pkmnSurname);
    console.log('START ANALYSIS OF: ', pkmnData.aliases[1] ?? pkmnData.aliases[0]);
    const gameUrlId: string = gameUrl.split('/').pop()!.split('.log')[0];
    pkmnData.overallUtility[gameUrlId] = this.getOverallUtility(
      pkmnData.aliases[1] ?? pkmnData.aliases[0],
      pkmnData,
      battlelog
    );

    return [pkmnName, pkmnData];
  }

  getTurnOnField(pkmnName: string, pkmnData: PokemonData, battleLog: string[]) {
    let turns = 0;
    let read = false;
    let stays = false;
    battleLog.forEach((line) => {
      if (line.includes('|start')) { read = true }
      if (line.includes('|win|')) { read = false }
      if (read && (line.includes(pkmnData.aliases[0]) || line.includes(pkmnData.aliases[1]))) {
        stays = true;
      }
      if (line.includes('|turn|') && stays) {
        turns +=1;
        stays=false;
      }
    });

    return turns;
  }

  getOverallUtility(pkmnName: string, pkmnData: PokemonData, battleLog: string[]): GameStats {
    // const moveRegex = new RegExp(`^\\|move\\|[^|]+\\|[^:]+: ${escapeRegExp(pkmnName)}`);
    const turnsOnField = this.getTurnOnField(pkmnName, pkmnData, battleLog);
    const moveRegex = new RegExp(`^\\|move\\|[^:]+: ${escapeRegExp(pkmnName)}`);
    const movesDone = battleLog
      .map((row, idx) => ({ row, idx }))
      .filter((row) => moveRegex.test(row.row));
    let totalDamage = 0;
    let totalKills = 0;
    console.log('moves done', movesDone);
    movesDone.forEach(({row: move, idx: moveIndex}) => {
      // battleLog.filter((row, rowIndex) => row === move);
      // const rowIndexWithMove = battleLog.findIndex((row) => row === move);
      const rowIndexWithMove = moveIndex;
      // if (move.includes('[still]')) return;
      console.log('analyzing row>', move, ' with rowIndex', rowIndexWithMove);
      const whoIsDamaged = battleLog[rowIndexWithMove].split('|')[4];
      const pkmnNameWithPlayerN = battleLog[rowIndexWithMove].split('|')[2];
      console.log('and it damaged', whoIsDamaged);
      if (whoIsDamaged === pkmnNameWithPlayerN) return console.log('it was a non damaging move');
      let whoIsDamagedPrevHealth = this.searchForPreviousHealth(
        whoIsDamaged,
        battleLog.slice(0, rowIndexWithMove)
      );
      console.log(
        'the pokemon ',
        pkmnName,
        'damaged ',
        whoIsDamaged,
        'that had ',
        whoIsDamagedPrevHealth,
        'hp befor taking damage'
      );

      if (move.includes('[spread]')) {
        const pkmnHitBySpread = move.split('|').pop()?.replace('[spread] ', '').split(',');
        console.log('spread move', move);
        pkmnHitBySpread?.forEach((pkmnSlot) => {
          const _whoIsDamaged =
            battleLog
              .slice(rowIndexWithMove)
              .find(
                (row) => row.includes('|-heal|' + pkmnSlot) || row.includes('|-damage|' + pkmnSlot)
              )
              ?.split('|')[2] ?? pkmnSlot;
          console.log('hit', _whoIsDamaged);
          const prevHealth = this.searchForPreviousHealth(
            _whoIsDamaged,
            battleLog.slice(0, rowIndexWithMove)
          );
          console.log('damaged in spread', _whoIsDamaged, ' with previous health: ', prevHealth);
          let dmgkillData = this.calculateDamage(
            totalKills,
            totalDamage,
            _whoIsDamaged,
            prevHealth,
            battleLog,
            rowIndexWithMove
          );
          totalDamage = dmgkillData.dmg;
          totalKills = dmgkillData.kills;
        });
      } else {
        let dmgkillData = this.calculateDamage(
          totalKills,
          totalDamage,
          whoIsDamaged,
          whoIsDamagedPrevHealth,
          battleLog,
          rowIndexWithMove
        );
        totalDamage = dmgkillData.dmg;
        totalKills = dmgkillData.kills;
      }

      console.log('damage shoudl be', totalDamage);
    });
    return { damageDone: totalDamage, kills: totalKills, turnsOnField: turnsOnField };
  }

  private calculateDamage(
    kills: number,
    totalDamage: number,
    whoIsDamaged: string,
    whoIsDamagedPrevHealth: number,
    battleLog: string[],
    rowIndexWithMove: number
  ) {
    /**
     * starting in moveInTurn+1 to check when the next move starts.
     * When a new |move| appears, it means the old one ended.
     */
    const rowIndexWhenAttackFinished = battleLog
      .slice(rowIndexWithMove + 1)
      .findIndex((row) => row.includes('|move|') || row.includes('|win|'));
    const whereToSearchForDamage = battleLog.slice(
      rowIndexWithMove,
      rowIndexWithMove + rowIndexWhenAttackFinished + 1
    );
    console.log('searching in rows', whereToSearchForDamage);
    const previousHealth = whereToSearchForDamage
      .filter((row) => row.includes('|-damage|') && row.split('|')[2] == whoIsDamaged && !row.split('|')[4]?.includes('[from]'))
      .map((row) => {
        console.log('view health drop', row.split('|').pop());
        return row.split('|').pop();
      })
      .reverse()
      .map((healthRemaining) => {
        /**
         * Inverto l'ordine perche' se l'ultima riga include 'fnt', non ho bisogno di calcolare tutti i turni di hit.
         * Il danno multi-attack ha ucciso il pokemon e quindi vuol dire che ha fatto tutta la vita rimasta.
         */
        if (healthRemaining?.includes('fnt')) {
          kills += 1;
          return { dmg: whoIsDamagedPrevHealth, kills: kills };
        }
        return { dmg: Number(healthRemaining?.split('/')[0]), kills: kills };
      });
    // .map(damage => {

    //   if (!damage?.includes('fnt')) {
    //     console.log('prev health was', whoIsDamagedPrevHealth, 'resulting health is', damage?.split('/')[0])
    //     return Number(damage?.split('/')[0]);
    //     // whoIsDamagedPrevHealth -= Number(damage?.split('/')[0]);
    //   }

    //   console.log('dealt with this move', whoIsDamagedPrevHealth);
    //   return whoIsDamagedPrevHealth;
    // });
    console.log('mmhh', previousHealth);
    if (previousHealth.length > 1) {
      totalDamage += previousHealth.pop()!.dmg! - previousHealth[0]!.dmg!;
      // previousHealth.reduce((acc, dmg) => acc + dmg, totalDamage);
    } else if (previousHealth.length === 1) {
      if (whoIsDamagedPrevHealth === previousHealth[0].dmg) totalDamage += whoIsDamagedPrevHealth;
      else totalDamage += whoIsDamagedPrevHealth - previousHealth[0].dmg;
    }
    return { dmg: totalDamage, kills: kills };
  }

  private searchForPreviousHealth(whoIsDamaged: string, battleLog: string[]): number {
    let rowWithPrevHealth = battleLog
      .reverse()
      .find(
        (row) =>
          row.includes(whoIsDamaged) &&
          (row.includes('|-damage|') || row.includes('|-heal|') || row.includes('|switch|'))
      );
    let previousHealth = rowWithPrevHealth?.includes('|switch|')
      ? rowWithPrevHealth?.split('|')[4]?.split('/')[0]
      : rowWithPrevHealth?.split('|')[3]?.split('/')[0];
    if (previousHealth === undefined) previousHealth = '100';
    return Number(previousHealth);
  }
}

