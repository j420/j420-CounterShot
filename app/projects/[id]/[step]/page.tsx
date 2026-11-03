import Workspace from "../../../../components/workspace";
export default async function ProjectStep({ params }: { params: Promise<{id:string;step:string}> }) { const {id,step}=await params; return <Workspace id={id} step={step}/>; }
