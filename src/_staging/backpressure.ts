{
  "code": "
// Import required modules
import { v4 as uuidv4 } from 'uuid';
import { createConnection, Entity, Column, PrimaryGeneratedColumn, OneToOne, JoinColumn } from 'typeorm';
import { TaskDescription } from './TaskDescription';

// Define the task retry entity
@Entity()
export class TaskRetry {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  taskId: string;

  @Column()
  attempt: number;

  @Column('json')
  gateFindings: any[];

  @Column()
  createdAt: Date;

  @OneToOne(() => TaskDescription)
  @JoinColumn()
  taskDescription: TaskDescription;
}

// Define the task description entity
@Entity()
export class TaskDescription {
  @PrimaryGeneratedColumn()
  id: string;

  @Column()
  description: string;

  @Column('json')
  gateFeedback: any[];
}

// Create a connection to the database
createConnection({
  type: 'postgres',
  url: 'localhost:5432',
  entities: [TaskRetry, TaskDescription],
}).then(async (connection) => {
  // Define the retry system function
  async function retrySystem(taskDescription: TaskDescription,