import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Component, computed, signal, Signal, WritableSignal } from '@angular/core';
import { FormArray, FormControl, FormGroup, UntypedFormBuilder, UntypedFormGroup } from '@angular/forms';
import { filter, forkJoin, map, take } from 'rxjs';
import { cloneDeep } from 'lodash';
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
        return url.split('/').pop();
      });
      this.loadData(urls)
    })
  }

  title = 'pokemonshowdown-game-analyzer';
  selectedPlayer: WritableSignal<string> = signal('');
  selectedPokemon: WritableSignal<string> = signal('');
  loading: WritableSignal<boolean> = signal(false);

  players: WritableSignal<{[player: string]: PlayerData}|null> = signal(null);
  pokemonList: WritableSignal<string[]> = signal([]);
  playerPokemons:Signal<string[]|null> = computed(() => {
    if (this.selectedPlayer() === '') return null;

    return Object.keys(this.players()![this.selectedPlayer()]['team']).filter((key) => 
      this.players()![this.selectedPlayer()]['team'][key].aliases[0] == key
    );
  });

  loadData(urls: string[]) {
    this.loading.set(true);
    const domParser = new DOMParser();
    
    // const apiCalls = urls.map(url => 
    //   this.http.get<any>(`/replay/${url}.log`, { responseType: "text" as "json" })
    // );

    const apiCalls = urls.map((url) =>
      this.http.get<any>(
        `/replay/${url}.log`, 
        { responseType: "text" as "json" }
      ).pipe(
        map((response) => ({ url, response }))
      )
    );

    forkJoin(apiCalls)
      .pipe(take(1))
      .subscribe((games) => {
        games.forEach(data => {
          this.initializeObjects(data.response, data.url);
        });
        this.loading.set(false);
      });
  }

  initializeObjects(data: string, gameUrl: string) {
    const battleLog: string[] = data.split('\n') ?? [];
    const p1name = battleLog.find(row => row.includes('|player|p1'))?.split('|')[3] ?? undefined;
    const p2name = battleLog.find(row => row.includes('|player|p2'))?.split('|')[3] ?? undefined;
    if (p1name === undefined || p2name === undefined) return;

    let p1pkmn: PlayerTeam = battleLog.filter(row => row.includes('|poke|p1')).map(row => row.split('|')[3]).reduce((acc: any, curr: string) => {acc[curr] = { aliases: [curr], turnsOnField: 0, kills: 0, supportMoves: 0, overallUtility: {}}; return acc}, {});
    let p2pkmn: PlayerTeam = battleLog.filter(row => row.includes('|poke|p2')).map(row => row.split('|')[3]).reduce((acc: any, curr: string) => {acc[curr] = { aliases: [curr], turnsOnField: 0, kills: 0, supportMoves: 0, overallUtility: {}}; return acc}, {});
    p1pkmn = this.elaboratePokemonData(p1pkmn, battleLog, gameUrl);
    p2pkmn = this.elaboratePokemonData(p2pkmn, battleLog, gameUrl);

    this.players.update(g => {
      if (g === null) g = {};
      if (!!!g[p1name]) {
        g[p1name] = { team: {} }
        g[p1name]['team'] = p1pkmn
      }
      if (!!!g[p2name]) {
        g[p2name] = { team: {} }
        g[p2name]['team'] = p2pkmn
      }
      return g;
    });
    this.players.set(cloneDeep(this.players()));
  }

  elaboratePokemonData(pokemonTeam: PlayerTeam, battleLog: string[], gameUrl: string) {
    pokemonTeam = Object.fromEntries(
      Object.entries(pokemonTeam)
        .map(([pkmnName, pkmnData]) => {
          return this.analyzeData(pkmnName, pkmnData, battleLog, gameUrl)
        })
      );
    Object.values(pokemonTeam).forEach((pkmnData: any) => {
      const surname = pkmnData['aliases'][1] as string;
      pokemonTeam[surname] = pkmnData;
    });
    return pokemonTeam;
  }

  analyzeData(pkmnName: string, pkmnData: PokemonData, battlelog: string[], gameUrl: string) {
    const pkmnSurname = battlelog.find((row) => row.includes('|switch|') && row.includes(pkmnName))?.split('|')[2].split(': ')[1]
    if (!!pkmnSurname) pkmnData['aliases'].push(pkmnSurname);
    console.log('analyzing the pokemon: ', pkmnData.aliases[1] ?? pkmnData.aliases[0])
    const gameUrlId: string = gameUrl.split('/').pop()!.split('.log')[0];
    pkmnData.turnsOnField = this.getTurnOnField(pkmnName, pkmnData, battlelog);
    pkmnData.overallUtility[gameUrlId] = this.getOverallUtility(pkmnData.aliases[1] ?? pkmnData.aliases[0], pkmnData, battlelog);
    
    return [pkmnName, pkmnData];
  }

  getTurnOnField(pkmnName: string, pkmnData: PokemonData, battleLog: string[]) {
    return battleLog.slice(
      battleLog.findIndex(row => row.includes('|turn|1'))
    ).filter(row => row.includes('|turn|') || row.includes(pkmnName)).length;
  }

  getOverallUtility(pkmnName: string, pkmnData: PokemonData, battleLog: string[]): GameStats {
    // const moveRegex = new RegExp(`^\\|move\\|[^|]+\\|[^:]+: ${escapeRegExp(pkmnName)}`);
    const moveRegex = new RegExp(`^\\|move\\|[^:]+: ${escapeRegExp(pkmnName)}`);
    const movesDone = battleLog.filter(row => moveRegex.test(row));
    let totalDamage = 0;
    movesDone.forEach(move => {
      console.log('analyzing row>', move);
      const moveInTurn = battleLog.findIndex(row => row === move);
      const whoDamaged = battleLog[moveInTurn].split('|')[4];
      const pkmnNameWithPlayerN = battleLog[moveInTurn].split('|')[2];
      console.log('and it damaged', whoDamaged);
      if (whoDamaged === pkmnNameWithPlayerN) return console.log('it was a non damaging move');
      // let whoDamagedPrevHealth = battleLog.slice(0, moveInTurn).reverse().find(row => row.includes(whoDamaged) && (row.includes('|-damage|') || row.includes('|-heal|')))?.split('|')[3]?.split('/')[0]
      // if (whoDamagedPrevHealth === undefined) whoDamagedPrevHealth = '100';
      let whoDamagedPrevHealth = this.searchForPreviousHealth(whoDamaged, battleLog.slice(0, moveInTurn));
      console.log('the pokemon ',pkmnName, 'damaged ', whoDamaged, 'that had ', whoDamagedPrevHealth, 'hp befor taking damage')
       
      const attackFinished = battleLog.slice(moveInTurn).findIndex(row => row.includes('|move|'))
      const whereToSearchForDamage = battleLog.slice(moveInTurn, moveInTurn + attackFinished);
      const damageOnTurn = whereToSearchForDamage.filter(row => 
        row.includes('|-damage|') && row.split('|')[2] == whoDamaged)
          .map(row => {
            return row.split('|').pop()
          })
          .map(damage => {
            if (damage?.includes('fnt'))
              return Number(whoDamagedPrevHealth)
            else
              return Number(whoDamagedPrevHealth) - Number(damage?.split('/')[0])
          })
          .reduce((acc, dmg) => acc + dmg, totalDamage);
      console.log('the damage dealt is', damageOnTurn)
    })
    console.log(movesDone, totalDamage);
    return {damageDone: totalDamage};
  }

  searchForPreviousHealth(whoIsDamaged: string, battleLog: string[]) {
    let previousHealth = battleLog.reverse().find(row => row.includes(whoIsDamaged) && (row.includes('|-damage|') || row.includes('|-heal|')))?.split('|')[3]?.split('/')[0]
    if (previousHealth === undefined) previousHealth = '100';
    return previousHealth;
  }
}
