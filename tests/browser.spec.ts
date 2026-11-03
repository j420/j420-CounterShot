import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';

test.use({ baseURL: process.env.BROWSER_BASE_URL || 'http://127.0.0.1:3001', launchOptions: { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

test('workshop jig sample preserves templates, six readiness conditions and unknown alignment across refresh', async ({page})=>{
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Projects',exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'How CounterShot works'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'What happens after upload?'})).toBeHidden();
  await page.getByText('What happens next?',{exact:true}).click();
  await expect(page.getByRole('heading',{name:'What happens after upload?'})).toBeVisible();
  await expect(page.getByText('Workshop: your clip is saved first.',{exact:false})).toBeVisible();
  await page.getByText('What happens next?',{exact:true}).click();
  for (const width of [320,390,768,1440]) {
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Camera',exact:true})).toBeInViewport();
    if (width === 390) await page.screenshot({path:'/tmp/countershot-minimal-home-390.png'});
  }
  await page.setViewportSize({width:1280,height:900});
  await page.screenshot({path:'/tmp/countershot-ui/home.png',fullPage:true});
  await page.getByRole('button',{name:'Explore a sample'}).click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/design/);
  await expect(page.getByText('You’re exploring a synthetic example.')).toBeVisible();
  await expect(page.getByRole('heading',{name:'What braces the wall while the hand joins?'})).toBeVisible();
  await expect(page.locator('.preview-canvas img')).toBeVisible();
  await expect.poll(()=>page.locator('.preview-canvas img').evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth>0)).toBe(true);
  await expect(page.locator('.preview-canvas img')).toHaveAttribute('src',/parts.svg$/);
  await page.screenshot({path:'/tmp/countershot-ui/design.png',fullPage:true});
  await page.getByRole('button',{name:'Setup & extraction',exact:true}).click();
  await expect(page.locator('.preview-canvas img')).toHaveAttribute('src',/setup.svg$/);
  const projectId=page.url().split('/projects/')[1].split('/')[0];
  const initialState=await page.request.get(`/api/projects/${projectId}`).then(r=>r.json());
  expect(initialState.project.workflow).toBe('workshop_jig');
  expect(initialState.designs[0].proposal.program).toBeNull();
  expect(initialState.designs[0].proposal.actions).toHaveLength(0);
  expect(initialState.designs[0].proposal.jigProgram.actions.length).toBeGreaterThan(0);
  await page.getByRole('link',{name:'Build this jig',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Templates, setup, and release.'})).toBeVisible();
  await expect(page.locator('.readiness-grid .checkbox-row')).toHaveCount(6);
  const printHref=await page.getByRole('link',{name:/Print & assembly pack/}).getAttribute('href');
  const printResponse=await page.request.get(printHref!);expect(printResponse.ok()).toBe(true);expect(await printResponse.text()).toContain('50');
  await page.getByLabel('The jig material matches this revision’s measured profile.').check();
  await page.getByLabel('The printed check square measures 50 mm on both sides.').check();
  await page.getByLabel('The datum base, braces, and front gate are complete and match the templates.').check();
  await page.getByLabel('Maker assistance and stock preparation').fill('Synthetic browser fixture. No physical jig or operating trial claimed.');
  await page.getByRole('button',{name:'Record jig build',exact:true}).click();
  await expect(page).toHaveURL(/\/trials$/);
  await expect(page.getByLabel(/^Observed maximum alignment error/)).toHaveValue('');
  await expect(page.locator('.criterion-row')).toHaveCount(6);
  await page.getByLabel('Assembly reviewer').fill('Synthetic browser fixture');
  await page.getByLabel('Assembly and release feedback').fill('Synthetic incomplete record. No enclosure was assembled or physically inspected.');
  await page.getByRole('button',{name:'Record inspected assembly',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Incomplete assembly evidence',exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading',{name:'Incomplete assembly evidence',exact:true})).toBeVisible();
  const state=await page.request.get(`/api/projects/${projectId}`).then(r=>r.json());
  expect(state.trials[0].observedAlignmentErrorMm).toBeNull();
  expect(state.trials[0].outcome).toBe('incomplete');
  expect(Object.keys(state.trials[0].criteria).sort()).toEqual(['registration','alignment','completion','release','reset','allowed_resources'].sort());
  expect(Object.values(state.builds[0].readiness)).toEqual([false,false,false,false,false,false]);
  const exportResponse=await page.request.get(`/api/projects/${projectId}/export`);expect(exportResponse.ok()).toBe(true);
  await page.screenshot({path:'/tmp/countershot-ui/trials.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Projects',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'/tmp/countershot-ui/mobile.png',fullPage:true});
});

test('actual workshop inputs save flat measured facts and joint windows without inferred capabilities',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'New project',exact:true}).click();
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toContainText('Custom workshop jig');
  await expect(page.getByRole('dialog').getByRole('textbox')).toHaveCount(2);
  await page.getByLabel('What are you trying to do?').fill('Use a jig to hold and align enclosure panels while my right hand joins the next low-force interlocking panel.');
  await page.getByLabel('What does finished mean?').fill('Registered panels joined within tolerance, gate parked, enclosure extracted intact, and jig reset.');
  await page.getByRole('button',{name:'Create project',exact:true}).click();
  await expect(page).toHaveURL(/\/capture$/);
  await page.getByRole('link',{name:'Confirm',exact:true}).click();
  await expect(page.getByLabel(/^Workpiece width/)).toHaveValue('');
  const groups=[
    {name:'The workpiece',values:[['Workpiece width','120'],['Workpiece depth','90'],['Workpiece height','70']]},
    {name:'Panel joints',values:[['Workpiece panel thickness','3'],['Joint insertion travel','4'],['Maximum permitted assembly lift','8']]},
    {name:'Alignment & release',values:[['Maximum alignment error','2']]},
    {name:'Jig material',values:[['Jig board thickness','1.5'],['Usable sheet width','600'],['Usable sheet height','450']]},
    {name:'Fit & folds',values:[['Measured slot clearance','0.5'],['Signed fold allowance','0']]},
    {name:'The workspace',values:[['Work area width','600'],['Work area depth','450']]},
    {name:'Reach',values:[['Reach area width','550'],['Reach area depth','400']]},
  ];
  for(const group of groups){await page.locator('.fact-group-tab').filter({hasText:group.name}).click();for(const[name,value]of group.values)await page.getByLabel(new RegExp(`^${name}`)).fill(value);}
  await page.locator('.fact-group-tab').filter({hasText:'Alignment & release'}).click();
  await page.getByLabel('Completed joints retain the enclosure after supports are removed').selectOption('true');
  await page.locator('.fact-group-tab').filter({hasText:'Joint access'}).click();
  for(const edge of ['left','right','rear','front']){
    await page.getByRole('tab',{name:new RegExp(`${edge} edge`)}).click();
    await page.getByLabel(/^Window start/).fill('0');await page.getByLabel(/^Window end/).fill('6');await page.getByLabel(/^Window bottom/).fill('0');await page.getByLabel(/^Window top/).fill('14');
  }
  await page.locator('.fact-group-tab').filter({hasText:'Capabilities'}).click();
  await expect(page.getByLabel('join',{exact:true})).not.toBeChecked();
  await page.getByLabel('Permitted body supports').fill('None. No second hand or body bracing.');
  for(const operation of ['take','locate','join','engage support','release support','park support','extract','place finished','reset'])await page.getByLabel(operation,{exact:true}).check();
  await page.getByLabel('Tools, constraints, and factual corrections').fill('Synthetic browser fixture measurements. Pre-cut low-force panels only; no physical success claimed.');
  await page.getByLabel('I confirm these measurements, access windows, release conditions, and operator-stated capabilities.').check();
  await page.getByRole('button',{name:'Save confirmed assembly',exact:true}).click();
  await expect(page).toHaveURL(/\/design$/);
  const projectId=page.url().split('/projects/')[1].split('/')[0];const state=await page.request.get(`/api/projects/${projectId}`).then(r=>r.json());
  if(state.meta.configured)await expect(page.getByRole('button',{name:'Generate a workshop jig',exact:true})).toBeEnabled();
  else await expect(page.getByRole('button',{name:'Generate a workshop jig',exact:true})).toBeDisabled();
  expect(state.snapshots[0].facts.workflow).toBe('workshop_jig');
  expect(state.snapshots[0].facts.workpieceWidthMm).toBe(120);
  expect(state.snapshots[0].facts.completedJointsSelfRetain).toBe(true);
  expect(state.snapshots[0].facts.jointZones).toHaveLength(4);
  expect(state.snapshots[0].facts.allowedOperations).toContain('join');
  expect(state.snapshots[0].facts.kitComponents).toBeUndefined();expect(state.designs).toHaveLength(0);
  await page.reload();
  await expect(page.getByText('Snapshot 1',{exact:true})).toBeHidden();
  await page.getByText('Project details',{exact:true}).click();
  await expect(page.getByText('Snapshot 1',{exact:true})).toBeVisible();
});

test('legacy carton history still renders its exact design and construction export',async({page})=>{
  await page.goto('/');
  const response=await page.request.post('/api/projects',{data:{workflow:'carton_packing',title:'Legacy carton browser fixture',goal:'Pack a lightweight item and accompanying card using one available hand.',finishedDefinition:'Correct contents, closed carton, parcel removed and station reset.',demo:true}});
  expect(response.ok()).toBe(true);const created=await response.json();
  await page.goto(`/projects/${created.project.id}/design`);
  await expect(page.getByRole('heading',{name:'Who holds what, at each step?'})).toBeVisible();
  await expect(page.locator('.preview-canvas img')).toBeVisible();
  const href=await page.locator('.preview-canvas img').getAttribute('src');const drawing=await page.request.get(href!);expect(drawing.ok()).toBe(true);expect(await drawing.text()).toContain('svg');
  await page.reload();await expect(page.getByRole('heading',{name:'Who holds what, at each step?'})).toBeVisible();
});

async function createWorkshopSample(page: import('@playwright/test').Page) {
  await page.goto('/');
  const response=await page.request.post('/api/projects',{data:{workflow:'workshop_jig',title:'Synthetic UI regression fixture',goal:'Exercise software record handling only; no physical assembly or provider request.',finishedDefinition:'Software assertions completed without claiming physical evidence.',demo:true}});
  expect(response.ok()).toBe(true);
  const {project}=await response.json();
  const state=await page.request.get(`/api/projects/${project.id}`).then(r=>r.json());
  return {project,state};
}

async function syntheticBuild(page: import('@playwright/test').Page,projectId:string,designId:string) {
  const response=await page.request.post(`/api/projects/${projectId}/builds`,{data:{designId,materialConfirmed:true,scaleConfirmed:true,partsConfirmed:true,deviations:'',makerAssistance:'Synthetic browser regression only; no physical jig claimed.',readiness:{stock_loading:false,datum_registration:false,joint_access:false,support_transfer:false,finished_release:false,reset:false}}});
  expect(response.ok()).toBe(true);
  return (await response.json()).build;
}

test('a committed assembly survives refresh failure and an uncertain retry reuses its operation ID',async({page})=>{
  const {project,state}=await createWorkshopSample(page);
  await syntheticBuild(page,project.id,state.designs[0].id);
  await page.goto(`/projects/${project.id}/trials`);
  await page.getByLabel('Assembly reviewer').fill('Synthetic regression reviewer');
  await page.getByLabel('Assembly and release feedback').fill('Saved once despite a failed refresh; synthetic record.');
  let failRefresh=false;
  const operationIds:string[]=[];
  await page.route(`**/api/projects/${project.id}`,async route=>{
    if(failRefresh){failRefresh=false;await route.fulfill({status:503,contentType:'application/json',body:'{"error":"Injected refresh outage"}'});return;}
    await route.continue();
  });
  let dropResponse=false;
  await page.route(`**/api/projects/${project.id}/trials`,async route=>{
    operationIds.push(route.request().postDataJSON().clientOperationId);
    const response=await route.fetch();
    if(dropResponse){dropResponse=false;await route.abort('failed');return;}
    if(operationIds.length===1)failRefresh=true;
    await route.fulfill({response});
  });
  await page.getByRole('button',{name:'Record inspected assembly',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Your action was saved'})).toBeVisible();
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await expect(page.getByLabel('Assembly and release feedback')).toHaveValue('');
  await page.getByRole('button',{name:'Refresh records',exact:true}).click();
  await expect(page.locator('.trial-card')).toHaveCount(1);
  expect(operationIds).toHaveLength(1);
  const committed=await page.request.get(`/api/projects/${project.id}`).then(r=>r.json());
  expect(committed.trials).toHaveLength(1);

  await page.getByLabel('Assembly and release feedback').fill('Uncertain network response; retry is the same synthetic attempt.');
  dropResponse=true;
  await page.getByRole('button',{name:'Record inspected assembly',exact:true}).click();
  await expect(page.locator('.error-banner')).toBeVisible();
  await expect(page.getByLabel('Assembly and release feedback')).toHaveValue('Uncertain network response; retry is the same synthetic attempt.');
  await page.getByRole('button',{name:'Record inspected assembly',exact:true}).click();
  await expect(page.locator('.trial-card')).toHaveCount(2);
  expect(operationIds).toHaveLength(3);
  expect(operationIds[1]).toBe(operationIds[2]);
  expect(operationIds[0]).not.toBe(operationIds[1]);
  const retried=await page.request.get(`/api/projects/${project.id}`).then(r=>r.json());
  expect(retried.trials).toHaveLength(2);
});

test('changing builds and saving an attempt clears every attempt-specific assembly field',async({page})=>{
  const {project,state}=await createWorkshopSample(page);
  const first=await syntheticBuild(page,project.id,state.designs[0].id);
  const second=await syntheticBuild(page,project.id,state.designs[0].id);
  await page.route(`**/api/projects/${project.id}`,async route=>{
    const response=await route.fetch();const value=await response.json();
    value.assets.push({id:'synthetic-selection-only',name:'Synthetic selection only.mp4',mime:'video/mp4',purpose:'trial'});
    await route.fulfill({response,json:value});
  });
  await page.goto(`/projects/${project.id}/trials`);
  await page.getByLabel('Jig build under test').selectOption(first.id);
  await page.getByLabel('Assembly reviewer').fill('Synthetic regression reviewer');
  await page.getByLabel('Assembly and release feedback').fill('First build only');
  await page.getByLabel('Duration (seconds, optional)').fill('42');
  await page.getByLabel(/^Observed maximum alignment error/).fill('3');
  await page.getByRole('combobox',{name:'Assembly trial evidence'}).selectOption('synthetic-selection-only');
  await page.getByLabel('Evidence completeness').selectOption('complete');
  await page.getByLabel('Panels registered against the intended datums').selectOption('pass');
  await page.getByLabel('Operating help, another hand, or an undeclared support was used.').check();
  await page.getByLabel('Jig build under test').selectOption(second.id);
  const assertEmpty=async()=>{
    await expect(page.getByLabel('Assembly and release feedback')).toHaveValue('');
    await expect(page.getByLabel('Duration (seconds, optional)')).toHaveValue('');
    await expect(page.getByLabel(/^Observed maximum alignment error/)).toHaveValue('');
    await expect(page.getByRole('combobox',{name:'Assembly trial evidence'})).toHaveValue('');
    await expect(page.getByLabel('Evidence completeness')).toHaveValue('incomplete');
    await expect(page.getByLabel('Operating help, another hand, or an undeclared support was used.')).not.toBeChecked();
    for(const select of await page.locator('.criterion-row select').all())await expect(select).toHaveValue('not_observed');
    await expect(page.getByLabel('Assembly reviewer')).toHaveValue('Synthetic regression reviewer');
  };
  await assertEmpty();
  await expect(page.getByRole('region',{name:'Build provenance and unresolved tests'})).toContainText('6 unresolved physical readiness checks');
  await page.getByLabel('Assembly and release feedback').fill('Second synthetic build attempt');
  await page.getByLabel('Duration (seconds, optional)').fill('21');
  await page.getByLabel(/^Observed maximum alignment error/).fill('0.5');
  await page.getByLabel('Panels registered against the intended datums').selectOption('pass');
  await page.getByLabel('Operating help, another hand, or an undeclared support was used.').check();
  await page.getByRole('button',{name:'Record inspected assembly',exact:true}).click();
  await expect(page.locator('.trial-card')).toHaveCount(1);
  await assertEmpty();
  await expect(page.locator('.trial-card')).toContainText('Failed: operating help, another hand, or an undeclared support was used.');
  const saved=await page.request.get(`/api/projects/${project.id}`).then(r=>r.json());
  expect(saved.trials[0].buildId).toBe(second.id);
  expect(saved.trials[0].feedback).toBe('Second synthetic build attempt');
  expect(saved.trials[0].durationSeconds).toBe(21);
});

test('construction instructions remain inside the panel at 320 and 390 pixels',async({page})=>{
  const {project}=await createWorkshopSample(page);
  await page.goto(`/projects/${project.id}/build`);
  await expect(page.locator('.instruction-columns')).toBeVisible();
  for(const width of [320,390]){
    await page.setViewportSize({width,height:844});
    const overflow=await page.locator('.instruction-columns').evaluate(element=>{
      const bounds=element.getBoundingClientRect();
      return [...element.querySelectorAll('div,h3,ul,ol,li')].filter(child=>{const rect=child.getBoundingClientRect();return rect.left<bounds.left-1||rect.right>bounds.right+1||child.scrollWidth>child.clientWidth+1;}).map(child=>child.textContent?.slice(0,100));
    });
    expect(overflow,`Instruction children overflow at ${width}px`).toEqual([]);
  }
});

test('completed generation selects its result while deliberate historical selection is preserved',async({page})=>{
  const {project,state}=await createWorkshopSample(page);
  const first=state.designs[0];
  const second={...first,id:'synthetic-history-2',number:2};
  const result={...first,id:'synthetic-result-3',number:3};
  let completed=false;
  await page.route(`**/api/projects/${project.id}`,async route=>{
    await route.fulfill({status:200,json:{...state,project:{...state.project,currentDesignId:completed?result.id:second.id},meta:{...state.meta,configured:true},designs:completed?[first,second,result]:[first,second],jobs:[{id:'synthetic-running-job',kind:'plan',status:completed?'completed':'running',stage:'Synthetic job state only; no provider request',createdAt:new Date().toISOString(),resultId:completed?result.id:null}]}});
  });
  await page.route('**/designs/*/artifacts/*.svg',route=>route.fulfill({status:200,contentType:'image/svg+xml',body:first.artifacts.packageSvg}));
  await page.goto(`/projects/${project.id}/design?revision=${first.id}`);
  await expect(page.locator('.revision-tab.active')).toHaveText('Jig revision 01');
  await expect(page.locator('.job-banner')).toBeVisible();
  completed=true;
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.revision-tab.active')).toHaveText('Jig revision 03');

  completed=false;
  await page.goto(`/projects/${project.id}/design?revision=${first.id}`);
  await expect(page.locator('.job-banner')).toBeVisible();
  await page.getByRole('button',{name:'Jig revision 02',exact:true}).click();
  completed=true;
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.job-banner')).toHaveCount(0);
  await expect(page.locator('.revision-tab.active')).toHaveText('Jig revision 02');
});

test('revision request freezes the selected attempt and its card links the exact evidence',async({page})=>{
  const {project,state}=await createWorkshopSample(page);
  const build=await syntheticBuild(page,project.id,state.designs[0].id);
  const trials=[];
  for(const feedback of ['First synthetic attempt','Second synthetic attempt']){
    const response=await page.request.post(`/api/projects/${project.id}/trials`,{data:{buildId:build.id,criteria:{registration:'not_observed',alignment:'not_observed',completion:'not_observed',release:'not_observed',reset:'not_observed',allowed_resources:'not_observed'},componentCounts:{},observedAlignmentErrorMm:null,completeness:'incomplete',undeclaredResources:false,feedback,durationSeconds:null,reviewer:'Synthetic regression reviewer',evidenceAssetId:null}});
    expect(response.ok()).toBe(true);trials.push((await response.json()).trial);
  }
  await page.route(`**/api/projects/${project.id}`,async route=>{
    const response=await route.fetch();const value=await response.json();value.meta.configured=true;
    value.assets.push({id:'synthetic-playback-id',name:'Synthetic mocked evidence.mp4',mime:'video/mp4',purpose:'trial'});
    value.trials[0].evidenceAssetId='synthetic-playback-id';
    await route.fulfill({response,json:value});
  });
  await page.route('**/assets/synthetic-playback-id',route=>route.fulfill({status:200,contentType:'video/mp4',body:Buffer.alloc(0)}));
  let requestBody: {sourceTrialIds?:string[];parentDesignId?:string}|undefined;
  await page.route(`**/api/projects/${project.id}/jobs`,async route=>{requestBody=route.request().postDataJSON();await route.fulfill({status:201,json:{job:{id:'synthetic-captured-job'}}});});
  await page.goto(`/projects/${project.id}/trials`);
  const recording=page.getByRole('link',{name:'Open this attempt’s recording · Synthetic mocked evidence.mp4'});
  await expect(recording).toHaveAttribute('href',`/api/projects/${project.id}/assets/synthetic-playback-id`);
  await expect(page.locator('.trial-card video')).toHaveAttribute('src',`/api/projects/${project.id}/assets/synthetic-playback-id`);
  await page.getByLabel('Assembly attempt to learn from').selectOption(trials[0].id);
  await page.getByRole('button',{name:'Revise from this assembly trial',exact:true}).click();
  await expect.poll(()=>requestBody?.sourceTrialIds).toEqual([trials[0].id]);
  expect(requestBody?.parentDesignId).toBe(state.designs[0].id);
  await expect(page.getByText('Job saved. You can leave this page and return while it runs.',{exact:true})).toBeVisible();
});

test('phone camera controls request rear capture and upload source and trial files in the same project',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const {project,state}=await createWorkshopSample(page);
  await syntheticBuild(page,project.id,state.designs[0].id);
  const current=await page.request.get(`/api/projects/${project.id}`).then(r=>r.json());
  const uploads:{purpose:string;name:string}[]=[];
  const intents:string[]=[];
  let analysisRequests=0;
  let releaseUpload:(()=>void)|undefined;
  await page.route(`**/api/projects/${project.id}`,route=>route.fulfill({status:200,json:current}));
  await page.route(`**/api/projects/${project.id}/upload-intents`,route=>{intents.push(route.request().postDataJSON().purpose);return route.fulfill({status:200,json:{upload:null}});});
  await page.route(`**/api/projects/${project.id}/jobs`,route=>{analysisRequests++;return route.fulfill({status:201,json:{job:{id:'offline-ui-analysis'}}});});
  await page.route(`**/api/projects/${project.id}/assets`,async route=>{
    const body=route.request().postDataBuffer()!.toString('utf8');
    const purpose=/name="purpose"\r\n\r\n([^\r\n]+)/.exec(body)?.[1]||'';
    const name=/filename="([^"]+)"/.exec(body)?.[1]||'';
    uploads.push({purpose,name});
    if(uploads.length===1)await new Promise<void>(resolve=>{releaseUpload=resolve;});
    const asset={id:`synthetic-phone-${uploads.length}`,name,mime:name.endsWith('.png')?'image/png':'video/mp4',purpose,byteLength:32,durationMs:name.endsWith('.png')?null:1000,createdAt:new Date().toISOString()};
    current.assets.push(asset);
    await route.fulfill({status:201,json:{asset}});
  });
  await page.route('**/assets/synthetic-phone-*',route=>route.fulfill({status:200,body:''}));
  await page.goto(`/projects/${project.id}/capture`);
  const source=page.getByRole('region',{name:'task media controls'});
  const video=source.getByLabel('Record task video',{exact:true});
  const photo=source.getByLabel('Take task photo',{exact:true});
  await expect(video).toHaveAttribute('capture','environment');
  await expect(video).toHaveAttribute('accept',/video\/quicktime/);
  await expect(photo).toHaveAttribute('capture','environment');
  await expect(photo).toHaveAttribute('accept',/image\/jpeg/);
  await expect(source.getByLabel('Upload task media',{exact:true})).not.toHaveAttribute('capture');
  await expect(page.getByRole('region',{name:'What to expect after upload'})).toContainText('Confirm real measurements');
  await expect(page.getByText('Show the original assembly method, existing aids,',{exact:false})).toBeHidden();
  await page.locator('summary').filter({hasText:/^What should I record\?$/}).click();
  await expect(page.getByText('Show the original assembly method, existing aids,',{exact:false})).toBeVisible();
  await video.dispatchEvent('cancel');
  expect(uploads).toHaveLength(0);
  const picker=page.waitForEvent('filechooser');
  await source.getByRole('button',{name:'Choose existing',exact:true}).click();
  await (await picker).setFiles({name:'phone-recording.mov',mimeType:'video/quicktime',buffer:Buffer.from('Synthetic camera wiring fixture; not physical footage')});
  await expect.poll(()=>uploads.length).toBe(1);
  await expect(source.getByRole('button',{name:'Take photo',exact:true})).toBeDisabled();
  await expect(source.getByRole('button',{name:'Choose existing',exact:true})).toBeDisabled();
  releaseUpload!();
  await expect(source.getByRole('button',{name:'Record video',exact:true})).toBeEnabled();
  await expect(source.getByRole('status')).toHaveText('Saved. Ready to analyze.');
  expect(analysisRequests).toBe(0);
  await expect(video).toHaveValue('');
  await photo.setInputFiles({name:'checkpoint.png',mimeType:'image/png',buffer:Buffer.from('Synthetic photo wiring fixture')});
  await expect.poll(()=>uploads.length).toBe(2);
  await expect(source.getByRole('button',{name:'Record video',exact:true})).toBeEnabled();
  await expect(photo).toHaveValue('');
  expect(uploads.map(upload=>upload.purpose)).toEqual(['source','source']);
  expect(analysisRequests).toBe(0);
  await page.getByRole('button',{name:'Analyze the job',exact:true}).click();
  await expect.poll(()=>analysisRequests).toBe(1);

  await page.goto(`/projects/${project.id}/trials`);
  const trial=page.getByRole('region',{name:'assembly trial media controls'});
  await expect(trial.getByRole('button',{name:'Take photo',exact:true})).toHaveCount(0);
  await expect(trial.getByLabel('Record assembly trial video',{exact:true})).toHaveAttribute('capture','environment');
  await trial.getByLabel('Record assembly trial video',{exact:true}).setInputFiles({name:'trial.webm',mimeType:'video/webm',buffer:Buffer.from('Synthetic trial upload wiring only')});
  await expect(page.getByRole('combobox',{name:'Assembly trial evidence'})).toHaveValue('synthetic-phone-3');
  expect(uploads[2]).toEqual({purpose:'trial',name:'trial.webm'});
  expect(intents).toEqual(['source','source','trial']);
  const smallInputs=await page.locator('.trial-form input:not([type="file"]):not([type="checkbox"]), .trial-form select, .trial-form textarea').evaluateAll(elements=>elements.filter(element=>parseFloat(getComputedStyle(element).fontSize)<16).map(element=>element.tagName));
  expect(smallInputs).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(trial.getByRole('button',{name:'Record video',exact:true})).toBeEnabled();
});

test('hybrid phone uploads use fresh credentialless tickets and never fall back after upload errors',async({page,context})=>{
  const {project,state}=await createWorkshopSample(page);
  const directUrl=`https://countershot-upload.example.test/api/projects/${project.id}/uploads`;
  await context.addCookies([{name:'synthetic_backend_cookie',value:'must-not-travel',url:directUrl,secure:true,sameSite:'None'}]);
  let intentMode:'direct'|'failure'|'invalid'|'expired'='direct';
  let failDirect=true;
  let intentCount=0;
  let localUploads=0;
  const directRequests:{authorization:string|undefined;cookie:string|undefined;keys:string[]}[]=[];
  await page.route(`**/api/projects/${project.id}`,route=>route.fulfill({status:200,json:state}));
  await page.route(`**/api/projects/${project.id}/assets`,route=>{localUploads++;return route.fulfill({status:500,json:{error:'Local media upload must not be used in hybrid mode'}});});
  await page.route(`**/api/projects/${project.id}/upload-intents`,route=>{
    intentCount++;
    expect(route.request().postDataJSON()).toEqual({purpose:'source'});
    if(intentMode==='failure')return route.fulfill({status:503,json:{error:'Injected upload authorization outage'}});
    return route.fulfill({status:200,json:{upload:{url:intentMode==='invalid'?`${directUrl}?unexpected=1`:directUrl,token:`synthetic-upload-ticket-${intentCount}`,expiresAt:new Date(Date.now()+(intentMode==='expired'?-60_000:300_000)).toISOString()}}});
  });
  await page.route(directUrl,async route=>{
    const origin=new URL(page.url()).origin;
    const cors={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type'};
    if(route.request().method()==='OPTIONS'){await route.fulfill({status:204,headers:cors});return;}
    const headers=await route.request().allHeaders();
    directRequests.push({authorization:headers.authorization,cookie:headers.cookie,keys:Object.keys(headers)});
    if(failDirect){await route.abort('failed');return;}
    const asset={id:'synthetic-hybrid-asset',name:'phone.mov',mime:'video/mp4',purpose:'source',byteLength:32,durationMs:1000,createdAt:new Date().toISOString(),original:{name:'phone.mov',mime:'video/quicktime',byteLength:48,sha256:'synthetic-only'}};
    state.assets.push(asset);
    await route.fulfill({status:201,headers:cors,json:{asset}});
  });
  await page.route('**/assets/synthetic-hybrid-asset*',route=>route.fulfill({status:200,body:''}));
  await page.goto(`/projects/${project.id}/capture`);
  const controls=page.getByRole('region',{name:'task media controls'});
  const recording=controls.getByLabel('Record task video',{exact:true});
  const fixture={name:'phone.mov',mimeType:'video/quicktime',buffer:Buffer.from('Synthetic direct upload wiring only')};
  await recording.setInputFiles(fixture);
  await expect(controls.locator('.error-banner')).toBeVisible();
  await expect(controls.getByRole('button',{name:'Record video',exact:true})).toBeEnabled();
  expect(intentCount).toBe(1);expect(directRequests).toHaveLength(1);expect(localUploads).toBe(0);

  failDirect=false;
  await recording.setInputFiles(fixture);
  await page.locator('summary').filter({hasText:/^Saved uploads/}).click();
  await expect(page.getByRole('link',{name:'Download original recording',exact:true})).toHaveAttribute('href',`/api/projects/${project.id}/assets/synthetic-hybrid-asset?original=1`);
  await expect(controls.getByRole('button',{name:'Record video',exact:true})).toBeEnabled();
  expect(intentCount).toBe(2);expect(directRequests).toHaveLength(2);
  expect(directRequests.map(request=>request.authorization)).toEqual(['Bearer synthetic-upload-ticket-1','Bearer synthetic-upload-ticket-2']);
  expect(directRequests.every(request=>!request.cookie)).toBe(true);
  expect(directRequests.every(request=>!request.keys.some(key=>/api.?key|backend.?key/i.test(key)))).toBe(true);

  for(const mode of ['failure','invalid','expired'] as const){
    intentMode=mode;
    await recording.setInputFiles(fixture);
    const message=mode==='failure'?'Injected upload authorization outage':mode==='invalid'?'invalid destination':'Upload access has expired';
    await expect(controls.locator('.error-banner')).toContainText(message);
    await expect(controls.getByRole('button',{name:'Record video',exact:true})).toBeEnabled();
    expect(directRequests).toHaveLength(2);expect(localUploads).toBe(0);
  }
  expect(intentCount).toBe(5);
  await expect(page.locator('body')).not.toContainText('synthetic-upload-ticket');
});


test('phone analysis selects a bounded original evidence set and later uploads do not change an explicit selection', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  const {project,state}=await createWorkshopSample(page);
  const asset=(index:number)=>({id:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,name:`Source ${index}.png`,mime:'image/png',purpose:'source',byteLength:1024,durationMs:null,createdAt:new Date().toISOString()});
  state.assets=Array.from({length:9},(_,index)=>asset(index+1));
  state.meta.configured=true;
  const requests: {kind:string;sourceAssetIds:string[]}[]=[];
  await page.route(`**/api/projects/${project.id}`,route=>route.fulfill({status:200,json:state}));
  await page.route(`**/api/projects/${project.id}/upload-intents`,route=>route.fulfill({status:200,json:{upload:null}}));
  await page.route(`**/api/projects/${project.id}/assets`,route=>{
    const uploaded=asset(10);state.assets.push(uploaded);
    return route.fulfill({status:201,json:{asset:uploaded}});
  });
  await page.route(`**/api/projects/${project.id}/assets/*`,route=>route.fulfill({status:200,body:''}));
  await page.route(`**/api/projects/${project.id}/jobs`,route=>{
    requests.push(route.request().postDataJSON());
    return route.fulfill({status:202,json:{job:{id:'offline-source-selection'}}});
  });
  await page.goto(`/projects/${project.id}/capture`);
  const analyze=page.getByRole('button',{name:'Analyze the job',exact:true});
  const selected=page.getByLabel('Selected analysis evidence');
  await expect(selected).toContainText('9 selected for Meta');
  await expect(selected).toContainText('Choose a smaller set below before analyzing.');
  await expect(analyze).toBeDisabled();
  await expect(page.getByRole('checkbox',{name:'Use Source 9.png for analysis',exact:true})).toBeVisible();
  await page.getByRole('checkbox',{name:'Use Source 9.png for analysis',exact:true}).uncheck();
  await page.getByRole('checkbox',{name:'Use Source 8.png for analysis',exact:true}).uncheck();
  await expect(selected).toContainText('7 selected for Meta');
  await expect(analyze).toBeEnabled();
  await page.getByRole('region',{name:'task media controls'}).getByLabel('Take task photo',{exact:true}).setInputFiles({name:'Source 10.png',mimeType:'image/png',buffer:Buffer.from('Synthetic source-selection wiring fixture')});
  const added=page.getByRole('checkbox',{name:'Use Source 10.png for analysis',exact:true});
  await expect(added).toBeVisible();
  await expect(added).not.toBeChecked();
  await expect(selected).toContainText('7 selected for Meta');
  await analyze.click();
  await expect.poll(()=>requests.length).toBe(1);
  expect(requests[0].kind).toBe('observe');
  expect(requests[0].sourceAssetIds).toEqual(state.assets.slice(0,7).map((source:{id:string})=>source.id));
  await expect(added).not.toBeChecked();
  for(let index=1;index<=7;index++)await page.getByRole('checkbox',{name:`Use Source ${index}.png for analysis`,exact:true}).uncheck();
  await expect(selected).toContainText('0 selected for Meta');
  await expect(analyze).toBeDisabled();
  expect(state.assets).toHaveLength(10);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

async function trackNativeCamera(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const state = { constraints: [] as MediaStreamConstraints[], tracks: [] as MediaStreamTrack[] };
    (window as unknown as { nativeCapture: typeof state }).nativeCapture = state;
    navigator.mediaDevices.getUserMedia = async constraints => {
      state.constraints.push(constraints || {});
      const stream = await original(constraints); state.tracks.push(...stream.getTracks()); return stream;
    };
  });
}

async function cameraTracksEnded(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const state = (window as unknown as { nativeCapture: { tracks: MediaStreamTrack[] } }).nativeCapture;
    return state.tracks.length > 0 && state.tracks.every(track => track.readyState === 'ended');
  });
}

test('in-app photo capture stays local until reviewed and uses real JPEG bytes without starting analysis', async ({ page }) => {
  await trackNativeCamera(page);
  await page.setViewportSize({ width: 320, height: 844 });
  const { project } = await createWorkshopSample(page);
  let uploads = 0, analyses = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/assets')) uploads++; if (request.method() === 'POST' && request.url().endsWith('/jobs')) analyses++; });
  await page.goto(`/projects/${project.id}/capture`);
  const source = page.getByRole('region', { name: 'task media controls' });
  await source.getByRole('button', { name: 'Take photo', exact: true }).click();
  const camera = page.getByRole('region', { name: 'task camera', exact: true });
  await expect(camera.getByRole('button', { name: 'Capture photo', exact: true })).toBeEnabled();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await camera.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await camera.getByLabel('Live camera preview').evaluate(video => video.getBoundingClientRect().right <= video.parentElement!.getBoundingClientRect().right + 1)).toBe(true);
    await page.screenshot({path:`/tmp/countershot-minimal-photo-${width}.png`});
  }
  await camera.getByRole('button', { name: 'Capture photo', exact: true }).click();
  await expect(camera.getByRole('img', { name: 'Photo to review before saving' })).toBeVisible();
  expect(uploads).toBe(0); expect(analyses).toBe(0);
  await expect.poll(() => cameraTracksEnded(page)).toBe(true);
  const constraints = await page.evaluate(() => (window as unknown as { nativeCapture: { constraints: MediaStreamConstraints[] } }).nativeCapture.constraints);
  expect(constraints.at(-1)?.audio).toBe(false);
  expect(constraints.at(-1)?.video).toMatchObject({ facingMode: { ideal: 'environment' } });
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/assets'));
  await camera.getByRole('button', { name: 'Use photo', exact: true }).click();
  const response = await saved; expect(response.status()).toBe(201);
  const { asset } = await response.json();
  expect(asset.mime).toBe('image/jpeg'); expect(asset.name).toMatch(/\.jpg$/); expect(asset.purpose).toBe('source');
  const savedImage = await page.request.get(`/api/projects/${project.id}/assets/${asset.id}`);
  expect(savedImage.ok()).toBe(true); expect(Array.from((await savedImage.body()).subarray(0, 3))).toEqual([255, 216, 255]);
  await expect(source.getByRole('status')).toHaveText('Saved. Ready to analyze.');
  await expect(camera).toHaveCount(0); expect(uploads).toBe(1); expect(analyses).toBe(0);
});

test('in-app video recording stops at its bound and saves a playable verified video only after review', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await trackNativeCamera(page);
  await page.addInitScript(() => {
    const original = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 179250) { (window as unknown as { nativeRecordingStop: number }).nativeRecordingStop = delay; return original(handler, 1100, ...args); }
      return original(handler, delay, ...args);
    }) as typeof window.setTimeout;
  });
  const { project } = await createWorkshopSample(page);
  let uploads = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/assets')) uploads++; });
  await page.goto(`/projects/${project.id}/capture`);
  const source = page.getByRole('region', { name: 'task media controls' });
  await source.getByRole('button', { name: 'Record video', exact: true }).click();
  const camera = page.getByRole('region', { name: 'task camera', exact: true });
  await camera.getByRole('button', { name: 'Start recording', exact: true }).click();
  await expect(camera.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
  await expect(camera.getByLabel('Recording to review before saving', { exact: true })).toBeVisible();
  const localReview = camera.getByLabel('Recording to review before saving', { exact: true });
  await expect.poll(() => localReview.evaluate((video: HTMLVideoElement) => video.readyState >= 2 && video.videoWidth > 0)).toBe(true);
  await localReview.evaluate((video: HTMLVideoElement) => video.play());
  await expect.poll(() => localReview.evaluate((video: HTMLVideoElement) => video.currentTime > 0)).toBe(true);
  await localReview.evaluate((video: HTMLVideoElement) => video.pause());
  await expect(camera.getByText('Stopped at the recording limit.', { exact: true })).toBeVisible();
  await camera.scrollIntoViewIfNeeded();
  await page.screenshot({path:'/tmp/countershot-minimal-video-review-390.png'});
  expect(await page.evaluate(() => (window as unknown as { nativeRecordingStop: number }).nativeRecordingStop)).toBeLessThan(180000);
  expect(uploads).toBe(0); await expect.poll(() => cameraTracksEnded(page)).toBe(true);
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/assets'));
  await camera.getByRole('button', { name: 'Use video', exact: true }).click();
  const response = await saved; expect(response.status()).toBe(201);
  const body = await response.json(); expect(body.asset.mime).toBe('video/mp4'); expect(body.asset.durationMs).toBeGreaterThan(0); expect(body.asset.durationMs).toBeLessThanOrEqual(180000);
  const original = body.asset.original || body.asset;
  expect(original.mime).toMatch(/^video\/(mp4|webm)$/); expect(original.name).toMatch(original.mime === 'video/mp4' ? /\.mp4$/ : /\.webm$/); expect(original.byteLength).toBeGreaterThan(0); expect(original.byteLength).toBeLessThan(50 * 1024 * 1024);
  const playback = await page.request.get(`/api/projects/${project.id}/assets/${body.asset.id}`); expect(playback.ok()).toBe(true); expect(playback.headers()['content-type']).toBe('video/mp4');
  await expect(source.getByRole('status')).toHaveText('Saved. Ready to analyze.'); expect(uploads).toBe(1);
});

test('a failed native capture upload retains the same local photo for an explicit retry', async ({ page }) => {
  const { project } = await createWorkshopSample(page);
  let attempts = 0;
  await page.route(`**/api/projects/${project.id}/assets`, async route => { attempts++; if (attempts === 1) await route.fulfill({ status: 503, json: { error: 'Synthetic upload outage before saving.' } }); else await route.continue(); });
  await page.goto(`/projects/${project.id}/capture`);
  const source = page.getByRole('region', { name: 'task media controls' });
  await source.getByRole('button', { name: 'Take photo', exact: true }).click();
  const camera = page.getByRole('region', { name: 'task camera', exact: true });
  await camera.getByRole('button', { name: 'Capture photo', exact: true }).click();
  const image = camera.getByRole('img', { name: 'Photo to review before saving' }); await expect(image).toBeVisible();
  const before = await image.getAttribute('src');
  await camera.getByRole('button', { name: 'Use photo', exact: true }).click();
  await expect(source.locator('.error-banner')).toContainText('Synthetic upload outage');
  await expect(image).toHaveAttribute('src', before!); await expect(camera.getByRole('button', { name: 'Use photo', exact: true })).toBeEnabled();
  await camera.getByRole('button', { name: 'Use photo', exact: true }).click();
  await expect(source.getByRole('status')).toHaveText('Saved. Ready to analyze.'); expect(attempts).toBe(2);
});

test('denied permission and unsupported recording offer the device camera without uploading', async ({ page }) => {
  const { project } = await createWorkshopSample(page);
  let uploads = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/assets')) uploads++; });
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Synthetic denied camera permission', 'NotAllowedError'); }; });
  await page.goto(`/projects/${project.id}/capture`);
  const source = page.getByRole('region', { name: 'task media controls' }); await source.getByRole('button', { name: 'Take photo', exact: true }).click();
  await expect(source.getByRole('alert')).toContainText('Camera permission is off');
  const chooser = page.waitForEvent('filechooser'); await source.getByRole('button', { name: 'Use device camera', exact: true }).click();
  expect(await (await chooser).element().getAttribute('capture')).toBe('environment'); expect(uploads).toBe(0);
  await page.addInitScript(() => { MediaRecorder.isTypeSupported = () => false; });
  await page.reload(); // A separate fresh context supplies a real fake camera below.
  await page.evaluate(() => { delete (navigator.mediaDevices as unknown as Record<string, unknown>).getUserMedia; });
  await source.getByRole('button', { name: 'Record video', exact: true }).click();
  await expect(source.getByRole('alert')).toContainText('cannot record video');
  expect(uploads).toBe(0);
});

async function deferNativeCamera(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const pending: { constraints: MediaStreamConstraints | undefined; resolve: (stream: MediaStream) => void }[] = [];
    const state = { requests: 0, tracks: [] as MediaStreamTrack[], release: async () => {
      for (const request of pending.splice(0)) { const stream = await original(request.constraints); state.tracks.push(...stream.getTracks()); request.resolve(stream); }
    } };
    (window as unknown as { deferredNativeCamera: typeof state }).deferredNativeCamera = state;
    navigator.mediaDevices.getUserMedia = constraints => new Promise<MediaStream>(resolve => { state.requests++; pending.push({ constraints, resolve }); });
  });
}
async function deferredNativeTracksEnded(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const state = (window as unknown as { deferredNativeCamera: { requests: number; tracks: MediaStreamTrack[] } }).deferredNativeCamera;
    return state.tracks.length === state.requests && state.tracks.length > 0 && state.tracks.every(track => track.readyState === 'ended');
  });
}
async function nativeRequests(page: import('@playwright/test').Page) { return page.evaluate(() => (window as unknown as { deferredNativeCamera: { requests: number } }).deferredNativeCamera.requests); }
async function releaseNativeCamera(page: import('@playwright/test').Page) { await page.evaluate(() => (window as unknown as { deferredNativeCamera: { release: () => Promise<void> } }).deferredNativeCamera.release()); }

test('closing or backgrounding a pending camera releases late permission results without capture', async ({ page }) => {
  await deferNativeCamera(page);
  const { project } = await createWorkshopSample(page);
  let uploads = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/assets')) uploads++; });
  await page.goto(`/projects/${project.id}/capture`);
  const source = page.getByRole('region', { name: 'task media controls' });
  await source.getByRole('button', { name: 'Take photo', exact: true }).click();
  await expect.poll(() => nativeRequests(page)).toBeGreaterThan(0);
  const firstRequests = await nativeRequests(page);
  await source.getByRole('button', { name: 'Close camera', exact: true }).click();
  await releaseNativeCamera(page);
  await expect.poll(() => deferredNativeTracksEnded(page)).toBe(true);
  await source.getByRole('button', { name: 'Take photo', exact: true }).click();
  await expect.poll(() => nativeRequests(page)).toBeGreaterThan(firstRequests);
  await expect(source.getByText('Opening camera…', { exact: true })).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(source.getByRole('alert')).toContainText('Camera paused');
  await releaseNativeCamera(page);
  await expect.poll(() => deferredNativeTracksEnded(page)).toBe(true);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(source.getByRole('button', { name: 'Try camera again', exact: true })).toBeEnabled(); expect(uploads).toBe(0);
});

test('a project becoming busy fences pending permission and lets the camera recover afterward', async ({ page }) => {
  await deferNativeCamera(page);
  const { project } = await createWorkshopSample(page);
  let releaseJob!: () => void;
  const job = new Promise<void>(resolve => { releaseJob = resolve; });
  await page.route(`**/api/projects/${project.id}/jobs`, async route => { await job; await route.fulfill({ status: 201, json: { job: { id: 'synthetic-paused-job' } } }); });
  await page.goto(`/projects/${project.id}/capture`);
  const source = page.getByRole('region', { name: 'task media controls' });
  await source.getByLabel('Take task photo', { exact: true }).setInputFiles({ name: 'synthetic-scene.png', mimeType: 'image/png', buffer: readFileSync('docs/examples/camera-harness_routing.png') });
  await expect(source.getByRole('status')).toHaveText('Saved. Ready to analyze.');
  await source.getByRole('button', { name: 'Take photo', exact: true }).click();
  await expect.poll(() => nativeRequests(page)).toBeGreaterThan(0);
  const firstRequests = await nativeRequests(page);
  await page.getByRole('button', { name: 'Analyze the job', exact: true }).click();
  await expect(source.getByRole('alert')).toContainText('Camera paused while the project is busy');
  releaseJob();
  await expect(source.getByRole('button', { name: 'Try camera again', exact: true })).toBeEnabled();
  await releaseNativeCamera(page);
  await expect.poll(() => deferredNativeTracksEnded(page)).toBe(true);
  await expect(source.getByRole('button', { name: 'Capture photo', exact: true })).toHaveCount(0);
  await source.getByRole('button', { name: 'Try camera again', exact: true }).click();
  await expect.poll(() => nativeRequests(page)).toBeGreaterThan(firstRequests);
  await releaseNativeCamera(page);
  await expect(source.getByRole('button', { name: 'Capture photo', exact: true })).toBeEnabled();
  await source.getByRole('button', { name: 'Close camera', exact: true }).click();
  await expect.poll(() => deferredNativeTracksEnded(page)).toBe(true);
});
